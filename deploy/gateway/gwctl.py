#!/usr/bin/python3 -I
"""Clinavat gateway controller.

Remote use: the Hub's dedicated SSH key is pinned to this program with a forced
command; one JSON request is read from stdin and one JSON response is written.
Local use (root shell): gwctl.py <op> [json-args], plus local-only maintenance ops.

The controller owns /etc/clinavat-gw/state.json and renders sing-box, nftables and
nginx from it. Infrastructure facts live in /etc/clinavat-gw/infra.json and can
only be changed by editing that file on the gateway.
"""
import fcntl
import hashlib
import ipaddress
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

ETC = '/etc/clinavat-gw'
VAR = '/var/lib/clinavat-gw'
INFRA_PATH = f'{ETC}/infra.json'
STATE_PATH = f'{ETC}/state.json'
CERT_DIR = f'{ETC}/certs'
ACME_HOME = f'{VAR}/acme'
# acme.sh runs as this user; sing-box excludes its uid from tun so DNS API calls leave directly.
ACME_USER = 'clinavat-acme'
REVISION_DIR = f'{VAR}/revisions'
APPLIED_PATH = f'{VAR}/applied.json'
PENDING_PATH = f'{VAR}/pending.json'
AUDIT_PATH = f'{VAR}/audit.jsonl'
LOCK_PATH = f'{VAR}/lock'
GWCTL = '/usr/local/lib/clinavat-gw/gwctl.py'

TARGETS = {
    'sing-box': '/etc/sing-box/config.json',
    'guard': f'{ETC}/rendered/guard.nft',
    'nginx': '/etc/nginx/sites-available/clinavat.conf',
    'nginx-map': '/etc/nginx/conf.d/clinavat-map.conf',
}
CONFIRM_SECONDS = 90
NODE_TYPES = {'vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive'}
RESERVED_TAGS = {'proxy', 'direct', 'block', 'dns', 'tun-in', 'unbound'}
# Per-source selectors and DNS servers are named after the source address.
RESERVED_PREFIXES = ('src-', 'dns-')
# Dial fields that could make a node leave through something other than its own server.
FORBIDDEN_NODE_FIELDS = {'detour', 'bind_interface', 'inet4_bind_address', 'inet6_bind_address',
                         'routing_mark', 'netns', 'reuse_addr', 'bind_address_no_port'}
SECRET_FIELD = re.compile(r'pass|uuid|secret|key|token|psk|obfs', re.I)
RULE_MATCH_KEYS = {'domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr',
                   'port', 'port_range', 'network', 'protocol'}
FQDN = re.compile(r'^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$')
TAG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
MAX_NODES, MAX_RULES, MAX_DEV_DIRECT, MAX_FORWARDS, MAX_SITES = 64, 200, 64, 32, 16
SOURCE_POLICIES = ('shared', 'bound')


class GatewayError(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read_json(path, default=None):
    try:
        with open(path) as handle:
            return json.load(handle)
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def atomic_write(path, content, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.gwctl-')
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def run(argv, timeout=60, check=True, stdin=None, env=None):
    result = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout,
                            env={**os.environ, **env} if env else None)
    if check and result.returncode != 0:
        raise GatewayError(f'{argv[0]} 失败：{(result.stderr or result.stdout).strip()[-800:]}')
    return result


def digest(content) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def file_digest(path):
    try:
        with open(path) as handle:
            return digest(handle.read())
    except FileNotFoundError:
        return None


def remote_mode() -> bool:
    return os.environ.get('CLINAVAT_GW_REMOTE') == '1'


def audit(action, status, **detail):
    os.makedirs(VAR, exist_ok=True)
    entry = {'at': now(), 'action': action, 'status': status,
             'via': 'hub' if remote_mode() else 'local', **detail}
    with open(AUDIT_PATH, 'a') as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + '\n')


# ---------------------------------------------------------------- validation

def network(value, label):
    try:
        return ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        raise GatewayError(f'{label} 不是有效的 CIDR：{value}（{error}）')


def validate_nodes(nodes):
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= MAX_NODES:
        raise GatewayError(f'节点数量必须在 1 到 {MAX_NODES} 之间')
    tags = set()
    for node in nodes:
        if not isinstance(node, dict):
            raise GatewayError('节点必须是对象')
        tag, kind = node.get('tag'), node.get('type')
        if not isinstance(tag, str) or not TAG.match(tag) or tag in RESERVED_TAGS or tag.startswith(RESERVED_PREFIXES):
            raise GatewayError(f'节点标签无效或为保留名：{tag!r}')
        if tag in tags:
            raise GatewayError(f'节点标签重复：{tag}')
        tags.add(tag)
        if kind not in NODE_TYPES:
            raise GatewayError(f'节点 {tag} 的类型 {kind!r} 不在允许列表中（{", ".join(sorted(NODE_TYPES))}）')
        bad = FORBIDDEN_NODE_FIELDS & set(node)
        if bad:
            raise GatewayError(f'节点 {tag} 不允许设置：{", ".join(sorted(bad))}')
        if not isinstance(node.get('server'), str) or not node['server'] or not isinstance(node.get('server_port'), int):
            raise GatewayError(f'节点 {tag} 缺少 server / server_port')
    return tags


def validate_rules(rules, node_tags):
    if not isinstance(rules, list) or len(rules) > MAX_RULES:
        raise GatewayError(f'分流规则最多 {MAX_RULES} 条')
    targets = node_tags | {'proxy'}
    for index, rule in enumerate(rules, 1):
        if not isinstance(rule, dict):
            raise GatewayError(f'第 {index} 条规则必须是对象')
        keys = set(rule) - {'outbound', 'action'}
        if not keys or keys - RULE_MATCH_KEYS:
            raise GatewayError(f'第 {index} 条规则的匹配字段无效：{", ".join(sorted(keys - RULE_MATCH_KEYS)) or "为空"}')
        if rule.get('action') == 'reject' and 'outbound' not in rule:
            continue
        if 'action' in rule or rule.get('outbound') not in targets:
            # Direct egress is reserved for the managed dev_direct list.
            raise GatewayError(f'第 {index} 条规则只能指向 proxy、某个节点，或 action=reject')
        for cidr in rule.get('ip_cidr', []):
            network(cidr, f'第 {index} 条规则')


def public_network(value):
    net = ipaddress.ip_network(value)
    return net.is_global and not net.is_multicast


def validate_dev_direct(values):
    if not isinstance(values, list) or len(values) > MAX_DEV_DIRECT:
        raise GatewayError(f'开发机直连名单最多 {MAX_DEV_DIRECT} 项')
    result = []
    for value in values:
        net = network(value, '开发机直连')
        if net.version != 4:
            raise GatewayError(f'开发机直连当前仅支持 IPv4：{value}')
        if net.prefixlen < 16:
            raise GatewayError(f'开发机直连范围过大（需 /16 或更小）：{value}')
        if not public_network(net):
            raise GatewayError(f'开发机直连只接受公网地址，内网段由 infra.json 管理：{value}')
        result.append(str(net))
    return sorted(set(result), key=lambda item: ipaddress.ip_network(item))


def validate_forwards(forwards, infra):
    if not isinstance(forwards, list) or len(forwards) > MAX_FORWARDS:
        raise GatewayError(f'端口映射最多 {MAX_FORWARDS} 项')
    seen = set()
    for item in forwards:
        if not isinstance(item, dict) or set(item) - {'proto', 'port', 'to_port', 'note'}:
            raise GatewayError('端口映射只允许 proto / port / to_port / note 字段')
        proto, port, to_port = item.get('proto', 'tcp'), item.get('port'), item.get('to_port')
        if proto not in ('tcp', 'udp') or not isinstance(port, int) or not isinstance(to_port, int):
            raise GatewayError('端口映射格式无效')
        if not 1024 <= port <= 65535 or not 1 <= to_port <= 65535:
            raise GatewayError(f'端口超出范围：{port} → {to_port}')
        if port in infra['reserved_ports']:
            raise GatewayError(f'端口 {port} 由网关自身使用，不能映射')
        if (proto, port) in seen:
            raise GatewayError(f'端口映射重复：{proto}/{port}')
        seen.add((proto, port))


def validate_sites(sites):
    if not isinstance(sites, list) or len(sites) > MAX_SITES:
        raise GatewayError(f'站点最多 {MAX_SITES} 个')
    result = []
    for domain in sites:
        domain = str(domain).strip().lower().rstrip('.')
        if not FQDN.match(domain):
            raise GatewayError(f'域名无效：{domain}')
        result.append(domain)
    return sorted(set(result))


def bindable_addresses(infra):
    """The pool machine and every VM address. Each has a fixed selector, so binding never restarts sing-box."""
    addresses = [infra['pool_ip']]
    if infra.get('vm_subnet'):
        addresses += [str(host) for host in vm_subnet(infra['vm_subnet']).hosts()]
    return addresses


def vm_subnet(value):
    net = network(value, 'vm_subnet')
    if net.version != 4 or not net.is_private or not 22 <= net.prefixlen <= 28:
        raise GatewayError(f'虚拟机网段必须是 /22 到 /28 的 IPv4 内网段：{value}')
    return net


def source_scope(infra):
    return [infra['lan_subnet'], *([infra['vm_subnet']] if infra.get('vm_subnet') else [])]


def validate_bindings(state, infra, tags):
    policy = state.setdefault('source_policy', 'shared')
    bindings = state.setdefault('bindings', {})
    if policy not in SOURCE_POLICIES:
        raise GatewayError(f'来源策略必须是 {" 或 ".join(SOURCE_POLICIES)}')
    allowed = set(bindable_addresses(infra))
    if not isinstance(bindings, dict):
        raise GatewayError('出口绑定必须是以来源地址为键的对象')
    for address, binding in bindings.items():
        if address not in allowed:
            raise GatewayError(f'{address} 不是可绑定的来源地址（号池机或虚拟机网段内的地址）')
        if not isinstance(binding, dict) or set(binding) - {'node', 'label'}:
            raise GatewayError(f'{address} 的绑定只允许 node / label 字段')
        if binding.get('node') not in tags:
            raise GatewayError(f'{address} 绑定的节点 {binding.get("node")!r} 不存在')
        if not isinstance(binding.get('label', ''), str) or len(binding.get('label', '')) > 80:
            raise GatewayError(f'{address} 的说明过长')
    if policy == 'bound' and infra['pool_ip'] not in bindings:
        raise GatewayError('按来源绑定出口时必须为号池机绑定节点，否则 Hub 自身无法联网')
    state['bindings'] = dict(sorted(bindings.items(), key=lambda item: ipaddress.ip_address(item[0])))


def validate_state(state, infra):
    tags = validate_nodes(state['nodes'])
    if state['selected'] not in tags:
        raise GatewayError(f'当前节点 {state["selected"]!r} 不存在')
    validate_bindings(state, infra, tags)
    validate_rules(state['rules'], tags)
    state['dev_direct'] = validate_dev_direct(state['dev_direct'])
    validate_forwards(state['forwards'], infra)
    state['sites'] = validate_sites(state['sites'])
    return state


# ---------------------------------------------------------------- rendering

def acme_account(infra):
    try:
        return pwd.getpwnam(infra.get('acme_user', ACME_USER))
    except KeyError:
        return None


def source_tag(address):
    return f'src-{address}'


def dns_tag(address):
    return f'dns-{address}'


def render_sing_box(state, infra):
    tags = [node['tag'] for node in state['nodes']]
    account = acme_account(infra)
    bound = state.get('source_policy') == 'bound'
    addresses = bindable_addresses(infra) if bound else []
    upstream = infra['dns']
    rejects = [dict(rule) for rule in state['rules'] if rule.get('action') == 'reject']
    others = [dict(rule) for rule in state['rules'] if rule.get('action') != 'reject']
    # DNS from the pool network is answered by sing-box, so it can follow the asking source's egress.
    route_rules = [{'inbound': 'tun-in', 'action': 'sniff', 'timeout': '1s'},
                   {'protocol': 'dns', 'action': 'hijack-dns'}, *rejects]
    dns_servers = [dict(upstream, tag='proxy-dns', detour='proxy')]
    dns_rules, selectors = [], []
    for address in addresses:
        # Selections change at runtime through the control API; the rendered default stays unbound,
        # so binding a source never changes this file or restarts sing-box.
        selectors.append({'type': 'selector', 'tag': source_tag(address), 'outbounds': ['unbound', *tags],
                          'default': 'unbound', 'interrupt_exist_connections': False})
        dns_servers.append(dict(upstream, tag=dns_tag(address), detour=source_tag(address)))
        dns_rules.append({'source_ip_cidr': [f'{address}/32'], 'server': dns_tag(address)})
        route_rules.append({'source_ip_cidr': [f'{address}/32'], 'outbound': source_tag(address)})
    if bound:
        # Unbound pool or VM addresses get nothing, not the shared node.
        dns_rules.append({'source_ip_cidr': source_scope(infra), 'action': 'reject'})
        route_rules.append({'source_ip_cidr': source_scope(infra), 'action': 'reject'})
    config = {
        'log': {'level': 'info'},
        'dns': {'servers': dns_servers, 'rules': dns_rules, 'final': 'proxy-dns', 'reverse_mapping': True,
                'strategy': 'prefer_ipv4'},
        'inbounds': [{
            'type': 'tun', 'tag': 'tun-in', 'interface_name': infra['tun_if'], 'address': [infra['tun_address']],
            'auto_route': True, 'strict_route': True,
            'route_exclude_address': infra['lan_direct'] + state['dev_direct'],
            # Gateway-local only: forwarded pool traffic has no socket owner and still enters tun.
            **({'exclude_uid': [account.pw_uid]} if account else {}),
        }],
        'outbounds': [
            # The gateway's own traffic, and all pool traffic under the shared policy.
            {'type': 'selector', 'tag': 'proxy', 'outbounds': tags, 'default': state['selected']},
            *selectors,
            *state['nodes'],
            # A dead end for unbound sources: it can only ever reach this gateway's own loopback.
            {'type': 'socks', 'tag': 'unbound', 'server': '127.0.0.1', 'server_port': 1},
            # Referenced by nothing: excluded addresses never enter tun. Kept for sing-box internals.
            {'type': 'direct', 'tag': 'direct'},
        ],
        'route': {
            'auto_detect_interface': True,
            # Domains the outbounds themselves must resolve; source-specific DNS rules apply to clients only.
            'default_domain_resolver': 'proxy-dns',
            # Node rules come after the source rules, so with bound sources they only affect the gateway itself.
            'rules': [*route_rules, *others],
            'final': 'proxy',
        },
        'experimental': {
            'clash_api': {'external_controller': infra['clash_api'], 'secret': infra['clash_secret']},
            'cache_file': {'enabled': True, 'path': f'{VAR}/sing-box-cache.db'},
        },
    }
    return json.dumps(config, indent=2, ensure_ascii=False) + '\n'


def nft_elements(values):
    return ', '.join(values) if values else ''


def render_guard(state, infra):
    lan_if, wan_if, pool_ip = infra['lan_if'], infra['wan_if'], infra['pool_ip']
    dnat = '\n'.join(
        f'    iifname "{wan_if}" {item.get("proto", "tcp")} dport {item["port"]} dnat ip to {pool_ip}:{item["to_port"]}'
        for item in state['forwards'])
    return f'''# Managed by gwctl. Do not edit; change /etc/clinavat-gw/state.json through gwctl.
table inet clinavat_guard
delete table inet clinavat_guard
table inet clinavat_guard {{
  set lan_direct {{
    type ipv4_addr; flags interval; auto-merge
    {"elements = { " + nft_elements(infra["lan_direct"]) + " }" if infra["lan_direct"] else ""}
  }}
  set dev_direct {{
    type ipv4_addr; flags interval; auto-merge
    {"elements = { " + nft_elements(state["dev_direct"]) + " }" if state["dev_direct"] else ""}
  }}
  chain prerouting {{
    type nat hook prerouting priority dstnat; policy accept;
{dnat}
  }}
  chain postrouting {{
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr {{ {", ".join(source_scope(infra))} }} oifname "{wan_if}" masquerade
  }}
  # Kill switch: the pool network may reach the WAN interface only for direct-listed
  # destinations or replies to inbound DNAT. Everything else must use the tun device.
  chain forward {{
    type filter hook forward priority filter - 10; policy accept;
    iifname "{lan_if}" oifname "{wan_if}" ip daddr @dev_direct accept
    iifname "{lan_if}" oifname "{wan_if}" ip daddr @lan_direct accept
    iifname "{lan_if}" oifname "{wan_if}" ct status dnat accept
    iifname "{lan_if}" oifname "{wan_if}" counter drop
    iifname "{lan_if}" oifname != {{ "{infra["tun_if"]}", "{wan_if}" }} counter drop
  }}
}}
'''


def render_nginx(state, infra):
    listen, upstream = infra['wan_ip'], f'{infra["pool_ip"]}:{infra["web_port"]}'
    blocks, missing = [], []
    for domain in state['sites']:
        cert = f'{CERT_DIR}/{domain}'
        if not (os.path.exists(f'{cert}/fullchain.pem') and os.path.exists(f'{cert}/key.pem')):
            missing.append(domain)
            continue
        blocks.append(f'''server {{
    listen {listen}:80;
    server_name {domain};
    return 301 https://$host$request_uri;
}}

server {{
    listen {listen}:443 ssl;
    http2 on;
    server_name {domain};
    ssl_certificate {cert}/fullchain.pem;
    ssl_certificate_key {cert}/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:clinavat_ssl:10m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 1m;

    location = /api/admin/site/settings {{
        client_max_body_size 6m;
        proxy_pass http://{upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $clinavat_connection_upgrade;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }}

    location / {{
        proxy_pass http://{upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $clinavat_connection_upgrade;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }}
}}
''')
    header = '# Managed by gwctl. Do not edit; change sites through gwctl.\n'
    if missing:
        header += f'# Waiting for certificates: {", ".join(missing)}\n'
    return header + '\n'.join(blocks)


NGINX_MAP = '''# Managed by gwctl.
map $http_upgrade $clinavat_connection_upgrade {
    default upgrade;
    '' close;
}
'''


def render_all(state, infra):
    rendered = {'sing-box': render_sing_box(state, infra), 'guard': render_guard(state, infra)}
    if shutil.which('nginx'):
        rendered['nginx'] = render_nginx(state, infra)
        rendered['nginx-map'] = NGINX_MAP
    return rendered


# ---------------------------------------------------------------- apply / health

def check_candidates(rendered):
    run(['sing-box', 'check', '-c', '/dev/stdin'], stdin=rendered['sing-box'])
    run(['nft', '-c', '-f', '-'], stdin=rendered['guard'])


def install_files(rendered):
    for name, content in rendered.items():
        atomic_write(TARGETS[name], content, 0o600 if name == 'sing-box' else 0o644)
    if 'nginx' in rendered:
        link = '/etc/nginx/sites-enabled/clinavat.conf'
        if not os.path.islink(link):
            os.symlink(TARGETS['nginx'], link)


def activate(changed, state, infra):
    if 'guard' in changed:
        run(['nft', '-f', TARGETS['guard']])
    if 'sing-box' in changed:
        run(['systemctl', 'restart', 'sing-box'], timeout=60)
    if changed & {'sing-box', 'selector'}:
        # cache_file restores the last runtime choice on restart, so always pin the state's nodes.
        pin_selectors(infra, state)
    if changed & {'nginx', 'nginx-map'}:
        run(['nginx', '-t'])
        run(['systemctl', 'reload-or-restart', 'nginx'])


def pin_selectors(infra, state, wait=15):
    choices = {'proxy': state['selected']}
    if state.get('source_policy') == 'bound':
        bindings = state.get('bindings', {})
        choices.update({source_tag(address): bindings.get(address, {}).get('node', 'unbound')
                        for address in bindable_addresses(infra)})
    deadline = time.time() + wait
    for tag, node in choices.items():
        while True:
            try:
                clash(infra, 'PUT', f'/proxies/{tag}', {'name': node}, timeout=3)
                break
            except Exception as error:
                if time.time() >= deadline:
                    raise GatewayError(f'无法通过 sing-box 控制接口把 {tag} 切换到 {node}：{error}')
                time.sleep(1)


def binding_drift(state, infra):
    """Sources whose live selection differs from the state, which would mean traffic leaving the wrong way."""
    if state.get('source_policy') != 'bound':
        return []
    proxies = (clash(infra, 'GET', '/proxies', timeout=5) or {}).get('proxies', {})
    bindings = state.get('bindings', {})
    return [address for address in bindable_addresses(infra)
            if proxies.get(source_tag(address), {}).get('now') != bindings.get(address, {}).get('node', 'unbound')]


def close_source_connections(infra, address):
    data = clash(infra, 'GET', '/connections') or {}
    closed = 0
    for item in data.get('connections') or []:
        if item.get('metadata', {}).get('sourceIP') == address:
            clash(infra, 'DELETE', f'/connections/{item["id"]}')
            closed += 1
    return closed


def egress_ip(timeout=8):
    result = run(['curl', '-s', '-m', str(timeout), 'https://cloudflare.com/cdn-cgi/trace'], check=False, timeout=timeout + 5)
    match = re.search(r'^ip=(\S+)$', result.stdout, re.M)
    return match.group(1) if match else None


def health(state, infra, wait=20):
    report = {'sing_box': False, 'tun': False, 'guard': False, 'egress_ip': None, 'upstream': None, 'sites': {}}
    deadline = time.time() + wait
    while time.time() < deadline:
        report['sing_box'] = run(['systemctl', 'is-active', '--quiet', 'sing-box'], check=False).returncode == 0
        report['tun'] = os.path.exists(f'/sys/class/net/{infra["tun_if"]}')
        if report['sing_box'] and report['tun']:
            break
        time.sleep(1)
    report['guard'] = run(['nft', 'list', 'table', 'inet', 'clinavat_guard'], check=False).returncode == 0
    try:
        report['binding_drift'] = binding_drift(state, infra) if report['sing_box'] else []
    except Exception as error:
        report['binding_drift'] = None
        report['binding_error'] = str(error)[:200]
    if report['tun']:
        for _ in range(3):
            report['egress_ip'] = egress_ip()
            if report['egress_ip']:
                break
            time.sleep(2)
    upstream = run(['curl', '-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}',
                    f'http://{infra["pool_ip"]}:{infra["web_port"]}/api/health'], check=False)
    report['upstream'] = upstream.stdout.strip() or None
    if shutil.which('nginx'):
        for domain in state['sites']:
            if not os.path.exists(f'{CERT_DIR}/{domain}/fullchain.pem'):
                report['sites'][domain] = 'NO_CERT'
                continue
            code = run(['curl', '-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}',
                        '--resolve', f'{domain}:443:{infra["wan_ip"]}', f'https://{domain}/api/health'], check=False)
            report['sites'][domain] = code.stdout.strip() or 'ERROR'
    problems = []
    if not report['sing_box'] or not report['tun']:
        problems.append('sing-box 或 tun 未就绪')
    if not report['guard']:
        problems.append('防泄漏护栏未加载')
    if report['binding_drift'] is None:
        problems.append(f'无法核对出口绑定：{report.get("binding_error")}')
    elif report['binding_drift']:
        problems.append(f'以下来源的实际出口与绑定不一致：{", ".join(report["binding_drift"][:10])}')
    if not report['egress_ip']:
        problems.append('经代理访问外网失败')
    elif report['egress_ip'] in infra.get('forbidden_egress_ips', []):
        problems.append(f'出口 IP {report["egress_ip"]} 属于禁止的真实出口')
    for domain, code in report['sites'].items():
        if code not in ('200', 'NO_CERT') and report['upstream'] == '200':
            problems.append(f'站点 {domain} 返回 {code}')
    report['problems'] = problems
    return report


def snapshot(revision):
    directory = f'{REVISION_DIR}/{revision:06d}'
    os.makedirs(directory, mode=0o700)
    for name, path in [('state', STATE_PATH), *TARGETS.items()]:
        if os.path.exists(path):
            shutil.copy2(path, f'{directory}/{name}')
    return directory


def next_revision():
    os.makedirs(REVISION_DIR, mode=0o700, exist_ok=True)
    numbers = [int(name) for name in os.listdir(REVISION_DIR) if name.isdigit()]
    return max(numbers, default=0) + 1


def record_applied(rendered):
    atomic_write(APPLIED_PATH, json.dumps({name: digest(content) for name, content in rendered.items()}, indent=1), 0o600)


def drift():
    applied = read_json(APPLIED_PATH, {})
    return sorted(name for name, value in applied.items() if file_digest(TARGETS[name]) != value)


def restore(revision):
    directory = f'{REVISION_DIR}/{revision:06d}'
    if not os.path.isdir(directory):
        raise GatewayError(f'版本 {revision} 不存在')
    for name, path in [('state', STATE_PATH), *TARGETS.items()]:
        if os.path.exists(f'{directory}/{name}'):
            shutil.copy2(f'{directory}/{name}', path)
        elif name in ('nginx', 'nginx-map') and os.path.exists(path):
            os.unlink(path)
    if not os.path.exists(TARGETS['nginx']) and os.path.islink('/etc/nginx/sites-enabled/clinavat.conf'):
        os.unlink('/etc/nginx/sites-enabled/clinavat.conf')
    # The guard is never removed by a rollback; an older table is still a kill switch.
    activate(set(TARGETS) | {'selector'}, read_json(STATE_PATH), read_json(INFRA_PATH))
    record_applied({name: open(path).read() for name, path in TARGETS.items() if os.path.exists(path)})


def cancel_timer(revision):
    run(['systemctl', 'stop', f'clinavat-gw-rollback-{revision}.timer'], check=False)


def transact(action, mutate, args, wait_confirm=True, activate_only=None):
    """Snapshot, mutate state, render, verify, activate, health-check and arm auto rollback."""
    if os.path.exists(PENDING_PATH):
        pending = read_json(PENDING_PATH)
        raise GatewayError(f'版本 {pending["revision"]} 正等待确认，请先 confirm 或 rollback')
    infra, state = read_json(INFRA_PATH), read_json(STATE_PATH)
    drifted = drift()
    if drifted and not args.get('overwrite_drift'):
        raise GatewayError(f'以下文件被手工修改过，拒绝覆盖：{", ".join(drifted)}（确认后传 overwrite_drift=true）')
    candidate = validate_state(mutate(json.loads(json.dumps(state))), infra)
    rendered = render_all(candidate, infra)
    check_candidates(rendered)
    changed = {name for name, content in rendered.items() if file_digest(TARGETS[name]) != digest(content)}
    if candidate['selected'] != state['selected'] or candidate.get('bindings') != state.get('bindings') \
            or candidate.get('source_policy') != state.get('source_policy'):
        changed.add('selector')
    if candidate == state and not changed:
        return {'changed': False}
    revision = next_revision()
    snapshot(revision)
    atomic_write(STATE_PATH, json.dumps(candidate, indent=2, ensure_ascii=False) + '\n', 0o600)
    install_files(rendered)
    try:
        activate(changed if activate_only is None else changed & activate_only, candidate, infra)
        report = health(candidate, infra)
    except Exception as error:
        restore(revision)
        audit(action, 'ROLLED_BACK', revision=revision, error=str(error))
        raise GatewayError(f'应用失败，已回滚：{error}')
    if report['problems']:
        restore(revision)
        audit(action, 'ROLLED_BACK', revision=revision, problems=report['problems'])
        raise GatewayError(f'健康检查未通过，已回滚：{"；".join(report["problems"])}')
    record_applied(rendered)
    if wait_confirm:
        run(['systemd-run', f'--unit=clinavat-gw-rollback-{revision}', f'--on-active={CONFIRM_SECONDS}',
             '--timer-property=AccuracySec=1s', GWCTL, 'timer-rollback', str(revision)])
        atomic_write(PENDING_PATH, json.dumps({'revision': revision, 'action': action,
                                               'deadline': time.time() + CONFIRM_SECONDS}), 0o600)
    audit(action, 'PENDING' if wait_confirm else 'APPLIED', revision=revision, changed=sorted(changed))
    return {'changed': True, 'revision': revision, 'pending': wait_confirm,
            'confirm_within_seconds': CONFIRM_SECONDS if wait_confirm else None, 'health': report}


# ---------------------------------------------------------------- clash api

def clash(infra, method, path, body=None, timeout=10):
    request = urllib.request.Request(f'http://{infra["clash_api"]}{path}', method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': f'Bearer {infra["clash_secret"]}',
                                              'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return json.loads(payload) if payload else None


# ---------------------------------------------------------------- operations

def mask(value):
    if isinstance(value, dict):
        return {key: ('***' if SECRET_FIELD.search(key) and not isinstance(item, (dict, bool)) else mask(item))
                for key, item in value.items()}
    if isinstance(value, list):
        return [mask(item) for item in value]
    return value


def op_status(args):
    infra, state = read_json(INFRA_PATH), read_json(STATE_PATH)
    report = health(state, infra, wait=1)
    pending = read_json(PENDING_PATH, {}) or None
    certs = {}
    for domain in state['sites']:
        path = f'{CERT_DIR}/{domain}/fullchain.pem'
        if os.path.exists(path):
            end = run(['openssl', 'x509', '-noout', '-enddate', '-in', path], check=False).stdout.strip()
            certs[domain] = end.removeprefix('notAfter=') or None
        else:
            certs[domain] = None
    return {'health': report, 'drift': drift(), 'pending': pending, 'certificates': certs,
            'selected': state['selected'], 'source_policy': state.get('source_policy', 'shared'),
            'bindings': state.get('bindings', {}), 'nginx_installed': bool(shutil.which('nginx'))}


def op_state_get(args):
    state = read_json(STATE_PATH)
    infra = read_json(INFRA_PATH)
    public_infra = {key: value for key, value in infra.items() if key != 'clash_secret'}
    return {'state': {'source_policy': 'shared', 'bindings': {}, **state, 'nodes': mask(state['nodes'])},
            'infra': {**public_infra, 'bindable': bindable_addresses(infra)}}


def merge_secret_fields(new, old):
    """Masked values coming back from the Hub keep the stored secret."""
    if isinstance(new, dict):
        return {key: (old.get(key) if item == '***' and isinstance(old, dict) else
                      merge_secret_fields(item, old.get(key) if isinstance(old, dict) else None))
                for key, item in new.items()}
    if isinstance(new, list):
        return [merge_secret_fields(item, old[index] if isinstance(old, list) and index < len(old) else None)
                for index, item in enumerate(new)]
    return new


def op_nodes_put(args):
    nodes = args.get('nodes')

    def mutate(state):
        previous = {node['tag']: node for node in state['nodes']}
        merged = [merge_secret_fields(node, previous.get(node.get('tag'))) for node in nodes]
        if any('***' in json.dumps(node) for node in merged):
            raise GatewayError('新节点的密钥字段不能为 ***')
        state['nodes'] = merged
        if state['selected'] not in {node['tag'] for node in merged}:
            state['selected'] = merged[0]['tag']
        return state
    return transact('nodes.put', mutate, args)


def op_selector_select(args):
    tag = args.get('tag')

    def mutate(state):
        state['selected'] = tag
        return state
    # Switch at runtime instead of restarting; the rendered default matches for the next restart.
    return transact('selector.select', mutate, args, activate_only={'selector'})


def op_binding_set(args):
    """Binds one source to a node, or unbinds it with node=null. Switches at runtime without restarting sing-box."""
    address, node, interrupt = args.get('address'), args.get('node'), args.get('interrupt') is True

    def mutate(state):
        bindings = state.setdefault('bindings', {})
        if node is None:
            bindings.pop(address, None)
        else:
            bindings[address] = {'node': node, 'label': args.get('label', bindings.get(address, {}).get('label', ''))}
        return state
    result = transact('binding.set', mutate, args, activate_only={'selector'})
    if result.get('changed') and interrupt:
        # Existing connections keep their old node unless the caller asks to cut them.
        result['closed_connections'] = close_source_connections(read_json(INFRA_PATH), address)
    return result


def op_source_policy_set(args):
    """Switches between one shared node for everything and per-source bindings. Restarts sing-box."""
    def mutate(state):
        state['source_policy'] = args.get('source_policy')
        return state
    return transact('source_policy.set', mutate, args)


def op_pin(args):
    """Local only: re-applies the state's node choices after sing-box starts."""
    pin_selectors(read_json(INFRA_PATH), read_json(STATE_PATH), wait=int(args.get('wait', 30)))
    return {'pinned': True}


def op_vm_subnet_set(args):
    """Local only: declares the VM network whose addresses reach the gateway unchanged."""
    infra = read_json(INFRA_PATH)
    previous = dict(infra)
    infra['vm_subnet'] = str(vm_subnet(args.get('vm_subnet')))
    atomic_write(INFRA_PATH, json.dumps(infra, indent=2, ensure_ascii=False) + '\n', 0o600)
    try:
        return transact('vm_subnet.set', lambda state: state, {**args, 'overwrite_drift': args.get('overwrite_drift')},
                        wait_confirm=False)
    except Exception:
        atomic_write(INFRA_PATH, json.dumps(previous, indent=2, ensure_ascii=False) + '\n', 0o600)
        raise


def op_rules_put(args):
    def mutate(state):
        state['rules'] = args.get('rules')
        return state
    return transact('rules.put', mutate, args)


def op_dev_direct_put(args):
    def mutate(state):
        state['dev_direct'] = args.get('dev_direct')
        return state
    return transact('dev_direct.put', mutate, args)


def op_forwards_put(args):
    def mutate(state):
        state['forwards'] = args.get('forwards')
        return state
    return transact('forwards.put', mutate, args)


def op_sites_put(args):
    if not shutil.which('nginx'):
        raise GatewayError('网关未安装 nginx')

    def mutate(state):
        state['sites'] = args.get('sites')
        return state
    return transact('sites.put', mutate, args)


def op_nodes_delay(args):
    infra, state = read_json(INFRA_PATH), read_json(STATE_PATH)
    url = 'https://www.gstatic.com/generate_204'
    result = {}
    for node in state['nodes']:
        try:
            result[node['tag']] = clash(infra, 'GET', f'/proxies/{node["tag"]}/delay?timeout=5000&url={url}', timeout=8).get('delay')
        except Exception as error:
            result[node['tag']] = None
            result.setdefault('_errors', {})[node['tag']] = str(error)[:200]
    return result


def op_connections(args):
    data = clash(read_json(INFRA_PATH), 'GET', '/connections') or {}
    connections = data.get('connections') or []
    return {'count': len(connections), 'upload': data.get('uploadTotal'), 'download': data.get('downloadTotal'),
            'connections': [{'host': item.get('metadata', {}).get('host') or item.get('metadata', {}).get('destinationIP'),
                             'chains': item.get('chains'), 'rule': item.get('rule')} for item in connections[:200]]}


def certs_sync(state):
    """Copy issued or renewed certificates from the acme.sh home into the nginx certificate tree."""
    changed = []
    for domain in state['sites']:
        source = f'{ACME_HOME}/{domain}_ecc'
        files = {'fullchain.pem': f'{source}/fullchain.cer', 'key.pem': f'{source}/{domain}.key'}
        if not all(os.path.exists(path) for path in files.values()):
            continue
        target = f'{CERT_DIR}/{domain}'
        os.makedirs(target, mode=0o700, exist_ok=True)
        for name, path in files.items():
            with open(path) as handle:
                content = handle.read()
            if file_digest(f'{target}/{name}') != digest(content):
                atomic_write(f'{target}/{name}', content, 0o600)
                changed.append(f'{domain}/{name}')
    if changed and shutil.which('nginx') and os.path.exists(TARGETS['nginx']):
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    return changed


def op_cert_issue(args):
    infra, state = read_json(INFRA_PATH), read_json(STATE_PATH)
    domain = validate_sites([args.get('domain', '')])[0]
    if domain not in state['sites']:
        raise GatewayError(f'{domain} 不在站点列表中，请先 sites.put')
    account = acme_account(infra)
    if not account:
        raise GatewayError(f'缺少系统用户 {infra.get("acme_user", ACME_USER)}，请重新运行 install.sh')
    tun = next(item for item in read_json(TARGETS['sing-box'])['inbounds'] if item.get('type') == 'tun')
    if account.pw_uid not in tun.get('exclude_uid', []):
        raise GatewayError('运行中的 sing-box 配置尚未排除 acme 用户，请先重新激活（install.sh）')
    acme = ['setpriv', f'--reuid={account.pw_uid}', f'--regid={account.pw_gid}', '--clear-groups', '--',
            'acme.sh', '--home', ACME_HOME, '--config-home', ACME_HOME]
    issue = run([*acme, '--issue', '--server', 'letsencrypt', '--dns', infra['acme_dns'],
                 '-d', domain, '--keylength', 'ec-256'], check=False, timeout=600, env={'HOME': ACME_HOME})
    # acme.sh exits 2 when the certificate is still valid and was skipped.
    if issue.returncode not in (0, 2):
        audit('cert.issue', 'FAILED', domain=domain)
        raise GatewayError(f'证书签发失败：{(issue.stdout + issue.stderr).strip()[-800:]}')
    synced = certs_sync(state)
    audit('cert.issue', 'ISSUED', domain=domain, synced=synced)
    # Re-render nginx now that the certificate exists.
    return transact('cert.enable', lambda current: current, {**args, 'overwrite_drift': True})


def op_certs_sync(args):
    """Local only: run by the renewal timer after acme.sh --cron."""
    changed = certs_sync(read_json(STATE_PATH))
    if changed:
        audit('certs.sync', 'RENEWED', files=changed)
    return {'changed': changed}


def op_confirm(args):
    pending = read_json(PENDING_PATH, {})
    revision = int(args.get('revision', -1))
    if pending.get('revision') != revision:
        raise GatewayError(f'没有等待确认的版本 {revision}')
    cancel_timer(revision)
    os.unlink(PENDING_PATH)
    audit('confirm', 'CONFIRMED', revision=revision)
    return {'confirmed': revision}


def op_rollback(args):
    revision = int(args.get('revision', -1))
    pending = read_json(PENDING_PATH, {})
    restore(revision)
    if pending.get('revision') == revision:
        cancel_timer(revision)
        os.unlink(PENDING_PATH)
    audit('rollback', 'ROLLED_BACK', revision=revision, reason=args.get('reason', 'manual'))
    return {'rolled_back_to_before': revision}


def op_timer_rollback(args):
    pending = read_json(PENDING_PATH, {})
    revision = int(args.get('revision', -1))
    if pending.get('revision') != revision:
        return {'skipped': True}
    restore(revision)
    os.unlink(PENDING_PATH)
    audit('rollback', 'ROLLED_BACK', revision=revision, reason='confirm timeout')
    return {'rolled_back_to_before': revision}


def op_revisions_list(args):
    if not os.path.isdir(REVISION_DIR):
        return []
    return sorted((int(name) for name in os.listdir(REVISION_DIR) if name.isdigit()), reverse=True)[:50]


def op_audit_tail(args):
    limit = min(int(args.get('limit', 100)), 500)
    try:
        with open(AUDIT_PATH) as handle:
            return [json.loads(line) for line in handle.readlines()[-limit:]]
    except FileNotFoundError:
        return []


def op_render(args):
    """Local only: write the rendered files to a directory for review without touching anything."""
    infra, state = read_json(INFRA_PATH), read_json(STATE_PATH)
    validate_state(state, infra)
    rendered = render_all(state, infra)
    check_candidates(rendered)
    directory = args.get('directory') or tempfile.mkdtemp(prefix='gwctl-render-')
    for name, content in rendered.items():
        atomic_write(f'{directory}/{name}', content, 0o600)
    return {'directory': directory, 'files': sorted(rendered)}


def build_import(config, args):
    """Derive infra.json / state.json from the hand-written sing-box config."""
    tun = next(item for item in config['inbounds'] if item.get('type') == 'tun')
    excluded = [str(network(value, 'route_exclude_address')) for value in tun.get('route_exclude_address', [])]
    dropped = set(args.get('drop_direct', []))
    nodes = [item for item in config['outbounds'] if item.get('type') in NODE_TYPES]
    final = config.get('route', {}).get('final')
    dns = next(item for item in config['dns']['servers'] if item.get('tag') == config['dns'].get('final'))
    infra = {
        'lan_if': args.get('lan_if', 'eth1'), 'wan_if': args.get('wan_if', 'eth0'),
        'tun_if': tun.get('interface_name', 'tun0'), 'tun_address': tun['address'][0],
        'lan_subnet': args.get('lan_subnet', '10.10.10.0/24'), 'pool_ip': args.get('pool_ip', '10.10.10.10'),
        'wan_ip': args['wan_ip'], 'web_port': int(args.get('web_port', 8080)),
        'lan_direct': [value for value in excluded if not public_network(value)],
        'reserved_ports': [22, 80, 443],
        'dns': {key: value for key, value in dns.items() if key not in ('tag', 'detour')},
        'clash_api': '127.0.0.1:9090', 'clash_secret': os.urandom(24).hex(),
        'acme_dns': args.get('acme_dns', 'dns_ali'), 'forbidden_egress_ips': args.get('forbidden_egress_ips', []),
    }
    state = {
        'nodes': nodes, 'selected': final if final in {node['tag'] for node in nodes} else nodes[0]['tag'],
        'rules': [], 'sites': args.get('sites', []),
        'dev_direct': [value for value in excluded if public_network(value) and value not in dropped],
        'forwards': args.get('forwards', [{'proto': 'tcp', 'port': 2222, 'to_port': 22, 'note': '号池机 SSH'},
                                          {'proto': 'tcp', 'port': 8080, 'to_port': 8080, 'note': '号池机 Web'}]),
    }
    return infra, validate_state(state, infra)


def op_import(args):
    """Local only: create infra.json and state.json from the current sing-box config."""
    if os.path.exists(STATE_PATH) and not args.get('force'):
        raise GatewayError(f'{STATE_PATH} 已存在；如需重新导入请传 force=true')
    infra, state = build_import(read_json(args.get('source', TARGETS['sing-box'])), args)
    atomic_write(INFRA_PATH, json.dumps(infra, indent=2, ensure_ascii=False) + '\n', 0o600)
    atomic_write(STATE_PATH, json.dumps(state, indent=2, ensure_ascii=False) + '\n', 0o600)
    audit('import', 'IMPORTED', nodes=[node['tag'] for node in state['nodes']], dev_direct=state['dev_direct'])
    return {'infra': {key: value for key, value in infra.items() if key != 'clash_secret'},
            'state': {**state, 'nodes': mask(state['nodes'])}}


def op_activate(args):
    """Local only: first activation after install, or re-activation after manual review."""
    return transact('activate', lambda state: state, {**args, 'overwrite_drift': True})


REMOTE_OPS = {
    'status': op_status, 'state.get': op_state_get, 'nodes.put': op_nodes_put,
    'selector.select': op_selector_select, 'rules.put': op_rules_put, 'dev_direct.put': op_dev_direct_put,
    'binding.set': op_binding_set, 'source_policy.set': op_source_policy_set,
    'forwards.put': op_forwards_put, 'sites.put': op_sites_put, 'nodes.delay': op_nodes_delay,
    'connections': op_connections, 'cert.issue': op_cert_issue, 'confirm': op_confirm,
    'rollback': op_rollback, 'revisions.list': op_revisions_list, 'audit.tail': op_audit_tail,
}
LOCAL_OPS = {**REMOTE_OPS, 'import': op_import, 'render': op_render, 'activate': op_activate, 'certs.sync': op_certs_sync,
             'timer-rollback': op_timer_rollback, 'pin': op_pin, 'vm_subnet.set': op_vm_subnet_set}
# pin runs from sing-box's ExecStartPost, while a change holding the lock may be waiting for that restart.
READ_ONLY = {'status', 'state.get', 'nodes.delay', 'connections', 'revisions.list', 'audit.tail', 'render', 'pin'}


def main():
    try:
        if remote_mode():
            request = json.loads(sys.stdin.read(1 << 20) or '{}')
            op, args, table = request.get('op'), request.get('args') or {}, REMOTE_OPS
        else:
            if len(sys.argv) < 2:
                raise GatewayError(f'用法：gwctl.py <{"|".join(sorted(LOCAL_OPS))}> [json 参数]')
            op = sys.argv[1]
            raw = sys.argv[2] if len(sys.argv) > 2 else '{}'
            args = {'revision': int(raw)} if raw.isdigit() else json.loads(raw)
            table = LOCAL_OPS
        if op not in table or not isinstance(args, dict):
            raise GatewayError(f'不支持的操作：{op!r}')
        if op in READ_ONLY:
            result = table[op](args)
        else:
            os.makedirs(VAR, mode=0o700, exist_ok=True)
            with open(LOCK_PATH, 'w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                result = table[op](args)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as error:
        message = str(error) if isinstance(error, (GatewayError, json.JSONDecodeError)) else f'{type(error).__name__}: {error}'
        print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
