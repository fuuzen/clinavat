"""Runtime firewall and routing policy for user-egress.py."""

import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time


CONFIG = Path("/etc/clinavat-user-egress")
STATE = CONFIG / "host.json"
SYSTEMD = Path("/etc/systemd/system")
RUNTIME = "/usr/local/lib/clinavat-user-egress-policy.py"
FIREWALL = "clinavat-user-egress-firewall.service"
ROUTES = "clinavat-user-egress-routes.service"
RESOLVER = Path("/run/systemd/resolve/io.systemd.Resolve")
RESOLVER_DROPIN = SYSTEMD / "systemd-resolved-varlink.socket.d/90-clinavat-user-egress.conf"
DBUS_POLICY = Path("/etc/dbus-1/system.d/90-clinavat-user-egress.conf")
HOST_TABLE = "clinavat_user_egress"
GW_TABLE = "clinavat_user_egress_gw"
GW_UNIT = "clinavat-user-egress-gateway.service"
GW_SCRIPT = "/etc/clinavat-user-egress/gateway-routes"
GW_DROPIN = SYSTEMD / "sing-box.service.d/91-clinavat-user-egress.conf"
GW_ROUTE_TABLE = "3182"
GW_PRIORITY = "8890"
HOST_PRIORITY = "3120"


def run(*args, data=None, check=True):
    return subprocess.run(args, input=data, capture_output=True, text=True, check=check, timeout=145).stdout


def put(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(content)
            file.close()
            temporary.chmod(mode)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def route_table(uid):
    return str(500000 + uid)


def dns_mark(uid):
    return hex(0xc1000000 | uid)


def host_rules(state):
    profiles = state["users"].values()
    interface = state["host_interface"]
    uids = ", ".join(str(p["uid"]) for p in profiles)
    lines = [f"destroy table inet {HOST_TABLE}", f"table inet {HOST_TABLE} {{"]

    def chain(name, hook, rules):
        lines.extend([f"  chain {name} {{", f"    {hook}; policy accept;"])
        lines.extend(f"    {rule}" for rule in rules)
        lines.append("  }")

    if uids:
        owned = f"meta skuid {{ {uids} }}"
        dns = "meta l4proto { tcp, udp } th dport 53"
        # route_localnet is needed after reverse NAT. Drop loopback addresses arriving on the wire.
        chain("loopback_guard", "type filter hook prerouting priority raw",
              [f'iifname "{interface}" ip {field} 127.0.0.0/8 drop' for field in ("saddr", "daddr")])
        chain("dns_mark", "type filter hook output priority mangle",
              [f'meta skuid {p["uid"]} ip daddr 127.0.0.0/8 {dns} meta mark set {dns_mark(p["uid"])}'
               for p in profiles])
        chain("dns_redirect", "type nat hook output priority dstnat - 5",
              [f"{owned} ip daddr 127.0.0.0/8 {dns} dnat ip to {state['dns']}"])
        chain("outbound_guard", "type filter hook output priority filter - 20", [
            f'{owned} fib daddr type local {dns} counter reject',
            f'{owned} meta nfproto ipv6 oifname != "lo" counter reject',
            f'{owned} oifname != {{ "lo", "{interface}" }} counter reject',
        ])
        chain("source_nat", "type nat hook postrouting priority srcnat - 5",
              [f'oifname "{interface}" meta skuid {p["uid"]} snat ip to {p["address"]}' for p in profiles])
        chain("source_guard", "type filter hook postrouting priority srcnat + 5", [
            f'{owned} oifname != {{ "lo", "{interface}" }} counter drop',
            *(f'oifname "{interface}" meta skuid {p["uid"]} ip saddr != {p["address"]} counter drop'
              for p in profiles),
        ])
    lines.append("}")
    return "\n".join(lines) + "\n"


def install_host_routes(state):
    interface = state["host_interface"]
    for _ in range(25):
        if Path(f"/sys/class/net/{interface}").exists():
            break
        time.sleep(1)
    sysctl = Path(f"/proc/sys/net/ipv4/conf/{interface}/route_localnet")
    sysctl.write_text("1\n")
    for profile in state["users"].values():
        uid, address = profile["uid"], profile["address"]
        table = route_table(uid)
        run("ip", "-4", "addr", "replace", f"{address}/32", "dev", "lo")
        run("ip", "-4", "route", "replace", "unreachable", "default", "metric", "32767", "table", table)
        run("ip", "-4", "route", "replace", "default", "via", state["gateway_ip"], "dev", interface,
            "onlink", "src", address, "metric", "100", "table", table)
        for selector in (("uidrange", f"{uid}-{uid}"), ("fwmark", dns_mark(uid))):
            rule = ("pref", HOST_PRIORITY, *selector, "lookup", table)
            run("ip", "-4", "rule", "del", *rule, check=False)
            run("ip", "-4", "rule", "add", *rule)


def delete_host_routes(profile):
    uid, address = profile["uid"], profile["address"]
    table = route_table(uid)
    for selector in (("uidrange", f"{uid}-{uid}"), ("fwmark", dns_mark(uid))):
        run("ip", "-4", "rule", "del", "pref", HOST_PRIORITY, *selector, "lookup", table, check=False)
    run("ip", "-4", "route", "flush", "table", table, check=False)
    run("ip", "-4", "addr", "del", f"{address}/32", "dev", "lo", check=False)


def resolver_policy(current, previous):
    profiles = current["users"].values()
    if profiles:
        acl = ",".join(f"u:{p['uid']}:---" for p in profiles)
        put(RESOLVER_DROPIN, "[Socket]\nSocketMode=0600\n"
            f"ExecStartPost=/usr/bin/setfacl -m o::rw,{acl} {RESOLVER}\n")
        lines = ['<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
                 ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">', "<busconfig>"]
        for user in current["users"]:
            lines.extend([f'  <policy user="{user}">',
                          '    <deny send_destination="org.freedesktop.resolve1"/>', "  </policy>"])
        put(DBUS_POLICY, "\n".join([*lines, "</busconfig>", ""]))
        run("setfacl", "-m", acl, str(RESOLVER))
    else:
        RESOLVER_DROPIN.unlink(missing_ok=True)
        DBUS_POLICY.unlink(missing_ok=True)
    for user, profile in previous["users"].items():
        if user not in current["users"]:
            run("setfacl", "-x", f"u:{profile['uid']}", str(RESOLVER))
    run("systemctl", "daemon-reload")
    run("systemctl", "reload", "dbus.service")


def install_host(current, previous):
    rules = host_rules(current)
    run("nft", "-c", "-f", "-", data=rules)
    if not current["users"]:
        sysctl = Path(f"/proc/sys/net/ipv4/conf/{current['host_interface']}/route_localnet")
        if sysctl.exists():
            sysctl.write_text(current["route_localnet"] + "\n")
    put(STATE, json.dumps(current, indent=2) + "\n", 0o600)
    run("nft", "-f", "-", data=rules)
    resolver_policy(current, previous)
    for user, profile in previous["users"].items():
        if user not in current["users"]:
            delete_host_routes(profile)
    if not current["users"]:
        run("systemctl", "disable", "--now", FIREWALL, ROUTES, check=False)
        run("nft", "destroy", "table", "inet", HOST_TABLE)
        for name in (FIREWALL, ROUTES):
            (SYSTEMD / name).unlink(missing_ok=True)
        Path(RUNTIME).unlink(missing_ok=True)
        run("systemctl", "daemon-reload")
        STATE.unlink(missing_ok=True)
        return

    put(Path(RUNTIME), Path(__file__).read_text())
    put(SYSTEMD / FIREWALL, f"""[Unit]
Description=Clinavat 本机用户出站限制
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 -I {RUNTIME} firewall

[Install]
WantedBy=sysinit.target
""")
    put(SYSTEMD / ROUTES, f"""[Unit]
Description=Clinavat 本机用户出站路由
Requires={FIREWALL}
After={FIREWALL} snap.lxd.daemon.service lxd.service
Before=systemd-user-sessions.service

[Service]
Type=oneshot
RemainAfterExit=yes
Restart=on-failure
RestartSec=5
ExecStart=/usr/bin/python3 -I {RUNTIME} routes

[Install]
WantedBy=multi-user.target
""")
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "--now", FIREWALL, ROUTES)
    install_host_routes(current)


def gateway_rules(state):
    tun = state["tun"]
    sources = ", ".join(p["address"] for p in state["users"].values())
    rules = [f"destroy table inet {GW_TABLE}"]
    if sources:
        # The public developer allowlist stays in effect for all other gateway sources.
        rules += [f"table inet {GW_TABLE} {{", "  chain egress_guard {",
                  "    type filter hook forward priority filter - 20; policy accept;",
                  f'    ip saddr {{ {sources} }} oifname != "{tun}" counter drop', "  }",
                  "  chain gateway_input {", "    type filter hook input priority filter - 20; policy accept;",
                  f'    iifname "{state["gateway_interface"]}" ip saddr {{ {sources} }} counter drop', "  }", "}"]
    return "\n".join(rules) + "\n"


def gateway_route_script(state):
    lan, tun = state["gateway_interface"], state["tun"]
    lines = ["#!/bin/sh", "set -eu", 'if [ "$1" = guard ]; then',
             f"  nft -f {CONFIG / 'gateway.nft'}",
             f"  ip -4 route replace unreachable default metric 32767 table {GW_ROUTE_TABLE}"]
    for profile in state["users"].values():
        address = profile["address"]
        rule = f"pref {GW_PRIORITY} from {address}/32 iif {lan} lookup {GW_ROUTE_TABLE}"
        lines += [f"  ip -4 rule del {rule} 2>/dev/null || :", f"  ip -4 rule add {rule}"]
    enabled = ("import json,sys; "
               "sys.exit(json.load(open('/etc/clinavat-gw/state.json')).get('source_policy') != 'bound')")
    lines += ["fi", f"if ! python3 -c {shlex.quote(enabled)}; then",
              f"  ip -4 route del default dev {tun} metric 100 table {GW_ROUTE_TABLE} 2>/dev/null || :",
              "  exit 0", "fi", "",
              "# The guard starts before sing-box. Only its post-start hook waits for the TUN.",
              "attempts=1",
              '[ "$1" != route ] || attempts=40',
              'while [ "$attempts" -gt 0 ]; do',
              f"  if ip -o -4 addr show dev {tun} up scope global 2>/dev/null | grep -q . &&",
              f"     ip -4 route replace default dev {tun} metric 100 table {GW_ROUTE_TABLE}; then",
              "    exit 0", "  fi",
              "  attempts=$((attempts - 1))",
              '  [ "$attempts" -eq 0 ] || sleep 0.25',
              "done",
              'if [ "$1" = route ]; then',
              f"  echo 'Timed out installing the user egress route through {tun}' >&2",
              "  exit 1", "fi"]
    return "\n".join(lines) + "\n"


def gateway_policy(gateway, current, previous):
    lan = current["gateway_interface"]
    sources = [p["address"] for p in current["users"].values()]
    nft_file = str(CONFIG / "gateway.nft")
    rules = gateway_rules(current)
    gateway.run("nft", "-c", "-f", "-", data=rules)
    gateway.put(nft_file, rules)
    if sources:
        gateway.put(GW_SCRIPT, gateway_route_script(current), "0755")
        gateway.put(SYSTEMD / GW_UNIT, f"""[Unit]
Description=Clinavat 本机用户网关出站限制
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target sing-box.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={GW_SCRIPT} guard

[Install]
WantedBy=sysinit.target
""")
        gateway.put(GW_DROPIN, f"""[Unit]
Wants={GW_UNIT}
After={GW_UNIT}

[Service]
ExecStartPost=-{GW_SCRIPT} route
""")
        gateway.run("systemctl", "daemon-reload")
        gateway.run("systemctl", "enable", GW_UNIT)
        gateway.run(GW_SCRIPT, "guard")
        gateway.run("systemctl", "start", GW_UNIT)
    else:
        gateway.run("systemctl", "disable", "--now", GW_UNIT, check=False)
        gateway.run("nft", "-f", nft_file)
        gateway.run("rm", "-f", str(SYSTEMD / GW_UNIT), str(GW_DROPIN), GW_SCRIPT, nft_file)
        gateway.run("systemctl", "daemon-reload")
    for profile in previous["users"].values():
        if profile["address"] not in sources:
            gateway.run("ip", "-4", "rule", "del", "pref", GW_PRIORITY, "from", f"{profile['address']}/32",
                        "iif", lan, "lookup", GW_ROUTE_TABLE, check=False)
    if not sources:
        gateway.run("ip", "-4", "route", "flush", "table", GW_ROUTE_TABLE, check=False)


if __name__ == "__main__":
    state = json.loads(STATE.read_text())
    if sys.argv[1] == "firewall":
        run("nft", "-f", "-", data=host_rules(state))
    else:
        install_host_routes(state)
