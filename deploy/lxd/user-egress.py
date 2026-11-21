#!/usr/bin/python3 -B
"""Bind local Linux UIDs to nodes on the Clinavat LXD gateway."""

import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

from user_egress_policy import RESOLVER, STATE, gateway_policy, install_host, route_table, run


def lxc(*args, data=None, check=True):
    return run(os.environ.get("CLINAVAT_LXC_BIN", "lxc"), *args, data=data, check=check)


class Gateway:
    def __init__(self, project, instance):
        self.project = project
        self.instance = instance

    def run(self, *args, data=None, check=True):
        return lxc("exec", self.instance, "--project", self.project, "--mode", "non-interactive",
                   "--", *args, data=data, check=check)

    def ctl(self, operation, value=None):
        args = [] if value is None else [json.dumps(value) if isinstance(value, dict) else str(value)]
        response = json.loads(self.run("/usr/local/lib/clinavat-gw/gwctl.py", operation, *args))
        if not response["ok"]:
            raise ValueError(response.get("error", "网关操作失败"))
        return response["result"]

    def put(self, path, content, mode="0644"):
        self.run("/bin/sh", "-ec", 'mkdir -p -- "$(dirname -- "$1")"; '
                 'tmp=$(mktemp "$1.XXXXXXXX"); trap \'rm -f -- "$tmp"\' EXIT; '
                 'cat > "$tmp"; chmod "$2" "$tmp"; mv -fT -- "$tmp" "$1"',
                 "sh", str(path), mode, data=content)


def bind(gateway, address, value):
    result = gateway.ctl("binding.set", {"address": address, "interrupt": True,
                                        **(value if value else {"node": None})})
    if result.get("pending"):
        gateway.ctl("confirm", result["revision"])


def initialize(gateway, args, infra):
    lan, tun = (infra[name] for name in ("lan_if", "tun_if"))
    address = ipaddress.IPv4Address(infra["pool_ip"])
    lan_network = ipaddress.IPv4Network(infra["lan_subnet"])
    local = json.loads(run("ip", "-j", "-4", "addr", "show"))
    interface = next((row["ifname"] for row in local if any(
        info["local"] == str(address) for info in row.get("addr_info", []))), None)
    remote = json.loads(gateway.run("ip", "-j", "-4", "addr", "show", "dev", lan))
    gateway_ip = next((info["local"] for row in remote for info in row.get("addr_info", [])
                       if ipaddress.IPv4Address(info["local"]) in lan_network), None)
    if not gateway_ip or not interface:
        raise ValueError("找不到网关与本机直连的 LAN")
    if not all(re.fullmatch(r"[\w.-]{1,15}", name) for name in (lan, tun, interface)):
        raise ValueError("不支持该网络接口名")
    sysctl = Path(f"/proc/sys/net/ipv4/conf/{interface}/route_localnet")
    return {"project": gateway.project, "gateway": gateway.instance, "host_interface": interface,
            "gateway_ip": gateway_ip, "gateway_interface": lan, "tun": tun, "dns": args.dns,
            "route_localnet": sysctl.read_text().strip(), "users": {}}


def verify_source(gateway, state, profile):
    uid, address = profile["uid"], profile["address"]
    route = json.loads(run("ip", "-j", "-4", "route", "get", state["dns"], "uid", str(uid)))[0]
    if route.get("prefsrc") != address or route.get("gateway") != state["gateway_ip"]:
        raise ValueError("本机 UID 路由未指向分配的来源地址和网关")
    gateway_route = json.loads(gateway.run("ip", "-j", "-4", "route", "get", state["dns"],
                                           "from", address, "iif", state["gateway_interface"]))[0]
    if gateway_route.get("dev") != state["tun"]:
        raise ValueError("网关未将该来源送入代理")
    run("runuser", "-u", profile["user"], "--", "test", "!", "-w", str(RESOLVER))
    run("runuser", "-u", profile["user"], "--", "getent", "ahostsv4", "api.ipify.org")
    public_ip = run("runuser", "-u", profile["user"], "--", "curl", "-q", "-4fsS", "--noproxy", "*",
                    "--max-time", "15", "https://api.ipify.org").strip()
    return str(ipaddress.IPv4Address(public_ip))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    apply = sub.add_parser("apply", help="添加用户或切换出口节点")
    apply.add_argument("user")
    apply.add_argument("node")
    apply.add_argument("--address", type=ipaddress.IPv4Address, help="首次设置时指定已预留的 VM 网段地址")
    apply.add_argument("--gateway", help="LXD 网关实例名")
    apply.add_argument("--gateway-project", help="LXD 网关项目名")
    apply.add_argument("--dns", type=ipaddress.IPv4Address)
    for command in ("remove", "check"):
        sub.add_parser(command).add_argument("user")
    sub.add_parser("status")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("请以 root 执行")
    with open("/run/lock/clinavat-user-egress.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(STATE.read_text()) if STATE.exists() else None
        if args.command == "status":
            for p in state["users"].values() if state else ():
                print(f"{p['user']}  uid={p['uid']}  {p['address']}  →  {p['node']}")
            if not state or not state["users"]:
                print("没有配置本机用户出口")
            return
        if args.command == "apply" and (not state or not state["users"]):
            gateway = Gateway(args.gateway_project or "clinavat-gateway", args.gateway or "clinavat-gateway")
        elif state:
            gateway = Gateway(state["project"], state["gateway"])
        else:
            raise ValueError("没有配置本机用户出口")
        overview = gateway.ctl("state.get")
        if args.command == "apply":
            missing = [cmd for cmd in ("ip", "nft", "arping", "curl", "setfacl") if not shutil.which(cmd)]
            if missing:
                raise ValueError(f"缺少命令 {', '.join(missing)}")
            if not RESOLVER.is_socket():
                raise ValueError("需要运行 systemd-resolved-varlink.socket")
            if args.dns and (not args.dns.is_global or args.dns.is_multicast):
                raise ValueError("--dns 需要公网 IPv4 解析器地址")
            if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_.-]{0,62}", args.user):
                raise ValueError("不支持该系统用户名")
            uid = pwd.getpwnam(args.user).pw_uid
            if not 1000 <= uid <= 0xffffff:
                raise ValueError("仅支持普通系统用户，UID 范围为 1000 至 16777215")
            if any(uid == p["uid"] and args.user != p["user"] for p in (state or {"users": {}})["users"].values()):
                raise ValueError("该 UID 已通过另一个用户名配置")
            if not state or not state["users"]:
                args.dns = str(args.dns or "1.1.1.1")
                state = initialize(gateway, args, overview["infra"])
            elif any(option is not None and str(option) != state[key] for option, key in
                     ((args.gateway_project, "project"), (args.gateway, "gateway"), (args.dns, "dns"))):
                raise ValueError("全部本机用户共用同一网关和 DNS；请先撤销已有配置再修改")
        update(gateway, state, overview, args)


def update(gateway, state, overview, args):
    user = args.user
    previous = state["users"].get(user)
    gateway_state = overview["state"]
    if args.command != "apply" and not previous:
        raise ValueError(f"{user} 没有配置出口")
    if args.command == "check":
        if gateway_state["source_policy"] != "bound" or gateway_state["bindings"].get(
                previous["address"]) != {"node": previous["node"], "label": f"Linux: {user}"}:
            raise ValueError("当前网关绑定与本机记录不一致")
        print(f"{user} → {previous['node']}，实测公网出口 {verify_source(gateway, state, previous)}")
        return
    profile = previous
    if args.command == "apply":
        if gateway_state["source_policy"] != "bound":
            raise ValueError("网关必须已启用按来源绑定")
        if args.node not in {node["tag"] for node in gateway_state["nodes"]}:
            raise ValueError(f"网关没有落地节点 {args.node}")
        if not previous and not args.address:
            raise ValueError("首次设置请用 --address 指定已预留的固定地址")
        if previous and args.address and str(args.address) != previous["address"]:
            raise ValueError("更换来源地址请先 remove，再 apply")
        address = previous["address"] if previous else str(args.address)
        subnet = ipaddress.IPv4Network(overview["infra"]["vm_subnet"])
        if ipaddress.IPv4Address(address) not in subnet.hosts():
            raise ValueError(f"{address} 不是 VM 网段 {subnet} 的可用地址")
        uid = pwd.getpwnam(user).pw_uid
        if previous and uid != previous["uid"]:
            raise ValueError("用户名对应的 UID 已变化，请先 remove 再 apply")
        profile = {"user": user, "uid": uid, "address": address, "node": args.node}
        if not previous:
            if run("ip", "-4", "route", "show", "table", route_table(uid), check=False):
                raise ValueError("本机路由表编号已被占用")
            route = json.loads(run("ip", "-j", "-4", "route", "get", address))[0]
            if route.get("type") == "local" or route.get("gateway"):
                raise ValueError(f"{address} 已被本机使用，或无法在本机 VM 网桥上预留")
            bridge = route["dev"]
            dhcp_ranges = lxc("network", "get", bridge, "ipv4.dhcp.ranges").strip()
            if not dhcp_ranges or any(ipaddress.IPv4Address(start) <= args.address <= ipaddress.IPv4Address(end)
                                      for start, end in (item.strip().split("-") for item in dhcp_ranges.split(","))):
                raise ValueError(f"{address} 必须在已显式划定的 DHCP 地址池之外")
            leases = json.loads(lxc("network", "list-leases", bridge, "-f", "json"))
            if any(lease["address"] == address for lease in leases):
                raise ValueError(f"{address} 已经分配给 LXD 实例")
            try:
                run("arping", "-D", "-I", bridge, "-c", "2", "-w", "3", address)
            except subprocess.CalledProcessError as error:
                raise ValueError(f"无法确认 {address} 未被占用：{error.stderr or error.stdout}") from error
    address = profile["address"]
    binding = gateway_state["bindings"].get(address)
    expected = {"node": previous["node"], "label": f"Linux: {user}"} if previous else None
    if binding != expected:
        raise ValueError(f"{address} 已被其他配置使用，或网关绑定已变化，请先核对")
    users = state["users"].copy()
    current = {**state, "users": users}
    if args.command == "apply":
        users[user] = profile
    else:
        del users[user]
    gateway_touched = host_touched = binding_changed = False
    try:
        if args.command == "apply":
            # Close the WAN bypass before enabling the local user's route.
            gateway_touched = True
            gateway_policy(gateway, current, state)
            bind(gateway, address, {"node": profile["node"], "label": f"Linux: {user}"})
            binding_changed = True
            host_touched = True
            install_host(current, state)
            observed = verify_source(gateway, current, profile)
            print(f"{user} → {profile['node']}，来源 {address}，实测公网出口 {observed}")
        else:
            bind(gateway, address, None)
            binding_changed = True
            host_touched = True
            install_host(current, state)
            gateway_touched = True
            gateway_policy(gateway, current, state)
            print(f"已移除 {user} 的专用出口")
    except (Exception, KeyboardInterrupt):
        try:
            if host_touched and not previous:
                install_host(state, current)
            if gateway_touched:
                gateway_policy(gateway, state, current)
            if binding_changed:
                bind(gateway, address, binding)
            if host_touched and previous:
                install_host(state, current)
        except Exception as error:
            print(f"恢复原设置失败，请检查本机和网关：{error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        detail = getattr(error, "stderr", "") or str(error)
        print(detail.strip(), file=sys.stderr)
        sys.exit(1)
