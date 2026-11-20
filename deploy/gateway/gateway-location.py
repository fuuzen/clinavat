#!/usr/bin/python3 -I
"""Probe one node's public egress without changing the running gateway."""
import ipaddress
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class ProbeError(Exception):
    pass


def interrupted(_signal, _frame):
    raise TimeoutError('出口位置查询超时，请重试或手动选择时区')


def text(value):
    return value[:160] if isinstance(value, str) else ''


def location(data, node, infra):
    if not isinstance(data, dict) or data.get('error') or data.get('success') is False:
        raise ProbeError('地理位置服务暂时不可用')
    try:
        address = ipaddress.ip_address(data.get('ip', ''))
    except ValueError as error:
        raise ProbeError('地理位置服务未返回有效出口 IP') from error
    if not address.is_global or address.is_multicast or str(address) in infra.get('forbidden_egress_ips', []):
        raise ProbeError('检测到非代理出口，无法推荐时区')
    timezone = data.get('timezone')
    if isinstance(timezone, dict):
        timezone = timezone.get('id')
    if not isinstance(timezone, str) or len(timezone) > 100:
        raise ProbeError('地理位置服务未返回时区')
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ProbeError('地理位置服务返回了无效时区') from error
    return {'node': node['tag'], 'ip': str(address), 'country': text(data.get('country_name') or data.get('country')),
            'region': text(data.get('region')), 'city': text(data.get('city')), 'timezone': timezone}


def probe(node, infra, outbounds=None, bootstrap=None):
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    password = secrets.token_hex(24)
    # Only proxy server connections and their bootstrap DNS leave directly on the WAN.
    # Client DNS/HTTPS follows the selected exit, including its front proxy dependencies.
    if outbounds is None:
        outbounds = [{**node, 'bind_interface': infra['wan_if'], 'domain_resolver': 'dns-bootstrap'}]
    if bootstrap is None:
        bootstrap = {**infra.get('bootstrap_dns', infra['dns']), 'tag': 'dns-bootstrap', 'bind_interface': infra['wan_if']}
        bootstrap.pop('detour', None)
    dns = {**infra['dns'], 'tag': 'node-dns', 'detour': node['tag']}
    config = {
        'log': {'disabled': True},
        'dns': {'servers': [bootstrap, dns], 'final': 'node-dns', 'strategy': 'prefer_ipv4'},
        'inbounds': [{'type': 'socks', 'listen': '127.0.0.1', 'listen_port': port,
                      'users': [{'username': 'location', 'password': password}]}],
        'outbounds': outbounds,
        'route': {'final': node['tag'], 'default_domain_resolver': 'node-dns'},
    }
    with tempfile.TemporaryDirectory(prefix='clinavat-location-') as directory:
        path = os.path.join(directory, 'sing-box.json')
        with open(path, 'w', opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
            json.dump(config, handle)
        checked = subprocess.run(['sing-box', 'check', '-c', path], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, timeout=5)
        if checked.returncode:
            raise ProbeError('独立代理探测配置无法加载，请检查节点及网关版本')
        process = subprocess.Popen(['sing-box', 'run', '-c', path], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 4
            while True:
                if process.poll() is not None:
                    raise ProbeError('独立代理探测未能启动，请检查节点及网关版本')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise ProbeError('独立代理探测启动超时')
                    time.sleep(0.05)
            for url in ('https://ipwho.is/?fields=ip,success,country,region,city,timezone.id', 'https://ipapi.co/json/'):
                try:
                    response = subprocess.run([
                        'curl', '-q', '--silent', '--fail', '--proto', '=https', '--max-time', '12',
                        '--connect-timeout', '8', '--max-filesize', '65536', '--noproxy', '',
                        '--socks5-hostname', f'127.0.0.1:{port}', '--proxy-user', f'location:{password}', url,
                    ], capture_output=True, text=True, timeout=14)
                    if response.returncode == 0 and len(response.stdout) <= 65536:
                        return location(json.loads(response.stdout), node, infra)
                except (json.JSONDecodeError, ProbeError, subprocess.TimeoutExpired):
                    continue
            raise ProbeError('无法经所选节点查询出口位置，可能是节点不可用或位置服务限流；请重试或手动选择时区')
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(40)
    try:
        request = json.loads(sys.stdin.read(1 << 20))
        print(json.dumps({'ok': True, 'result': probe(request['node'], request['infra'],
                                                   request.get('outbounds'), request.get('bootstrap_dns'))}, ensure_ascii=False))
    except Exception as error:
        message = str(error) if isinstance(error, (ProbeError, TimeoutError)) else '出口位置探测失败，请检查节点后重试或手动选择时区'
        print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
