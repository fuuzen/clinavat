#!/usr/bin/python3 -I
"""Evaluate whether a firewalld zone's target, ports, services, and rich rules allow a TCP port."""

from __future__ import annotations

import ipaddress
import shlex
import sys
from typing import Optional


def port_in_spec(spec: str, port_num: int) -> bool:
    if "-" in spec:
        lo, hi = spec.split("-", 1)
        return lo.isdigit() and hi.isdigit() and int(lo) <= port_num <= int(hi)
    return spec.isdigit() and int(spec) == port_num


def parse_ip_net(addr: Optional[str], expected_version: Optional[int] = None):
    if not addr:
        return None
    try:
        net = ipaddress.ip_network(addr, strict=False)
    except ValueError:
        return None
    if expected_version is not None and net.version != expected_version:
        return None
    return net


def main() -> int:
    bridge_ip = ipaddress.ip_address(sys.argv[1]) if sys.argv[1] else None
    source_net = ipaddress.ip_network(sys.argv[2], strict=False) if sys.argv[2] else None
    req_family = ("ipv4" if source_net.version == 4 else "ipv6") if source_net is not None else None
    target_port = int(sys.argv[3])
    target, ports, services = sys.argv[4], sys.argv[5], sys.argv[6]

    accept_prios = []
    block_prios = []

    if target.strip().upper() == "ACCEPT":
        accept_prios.append(float("inf"))

    for entry in ports.split():
        if "/" in entry:
            spec, proto = entry.split("/", 1)
            if proto.lower() == "tcp" and port_in_spec(spec, target_port):
                accept_prios.append(0)
                break

    if target_port == 22 and "ssh" in services.split():
        accept_prios.append(0)

    ignored = {"forward-port", "masquerade", "icmp-block", "icmp-type", "source-port", "mark"}
    actions = {"accept", "drop", "reject"}
    clauses = {"source", "destination", "port", "service", "protocol", "log", "nflog", "audit", "limit"} | actions | ignored

    def classify_rich_rule(line: str):
        try:
            tokens = shlex.split(line)
        except ValueError:
            return None
        if not tokens or tokens[0] != "rule":
            return None

        priority = 0
        family = action = source_addr = dest_addr = service_name = proto_val = None
        port_clause = None
        has_source = has_dest = src_not = dst_not = False
        src_non_addr = dst_non_addr = False
        clause = "rule"

        for tok in tokens[1:]:
            low = tok.lower()
            if "=" not in tok:
                if low in ignored:
                    return None
                if low == "not":
                    if clause == "source":
                        src_not = True
                    elif clause == "destination":
                        dst_not = True
                    continue
                if low in actions:
                    if action is not None:
                        return None
                    action, clause = low, low
                elif low in clauses:
                    clause = low
                    if clause == "source":
                        has_source = True
                    elif clause == "destination":
                        has_dest = True
                    elif clause == "port":
                        port_clause = {}
                continue

            key, val = tok.split("=", 1)
            k = key.lower()
            if clause == "rule":
                if k == "family":
                    family = val.lower()
                elif k == "priority":
                    try:
                        priority = int(val)
                    except ValueError:
                        return None
            elif clause == "source":
                if k == "address":
                    source_addr = val
                else:
                    src_non_addr = True
            elif clause == "destination":
                if k == "address":
                    dest_addr = val
                else:
                    dst_non_addr = True
            elif clause == "port" and port_clause is not None:
                port_clause[k] = val
            elif clause == "service" and k == "name":
                service_name = val
            elif clause == "protocol" and k == "value":
                proto_val = val.lower()

        if action is None:
            return None
        if req_family is not None:
            if family is not None and family != req_family:
                return None
        elif family == "ipv6":
            return None

        port_ok = (
            port_clause is not None
            and port_clause.get("protocol", "").lower() == "tcp"
            and port_in_spec(port_clause.get("port", ""), target_port)
        )
        service_ok = target_port == 22 and service_name == "ssh"

        if action == "accept":
            if src_not or dst_not or src_non_addr or dst_non_addr or not (port_ok or service_ok):
                return None
            if has_dest:
                if bridge_ip is None:
                    return None
                dst_net = parse_ip_net(dest_addr, bridge_ip.version)
                if dst_net is None or bridge_ip not in dst_net:
                    return None
            if has_source:
                if source_net is None:
                    return None
                src_net = parse_ip_net(source_addr, source_net.version)
                if src_net is None or not source_net.subnet_of(src_net):
                    return None
            return ("accept", priority)

        has_l4 = port_clause is not None or service_name is not None or proto_val is not None
        l4_matches = (not has_l4) or port_ok or service_ok or (proto_val == "tcp" and port_clause is None and service_name is None)
        if not l4_matches:
            return None
        if has_dest:
            if bridge_ip is None or dst_non_addr:
                return None
            dst_net = parse_ip_net(dest_addr, bridge_ip.version)
            if dst_net is None or (bridge_ip in dst_net) == dst_not:
                return None
        if has_source:
            if source_net is None:
                if not src_not:
                    return None
            else:
                if src_non_addr:
                    return None
                src_net = parse_ip_net(source_addr, source_net.version)
                if src_net is None:
                    return None
                if src_not:
                    if source_net.subnet_of(src_net):
                        return None
                elif not source_net.overlaps(src_net):
                    return None
        return ("block", priority)

    for line in sys.stdin:
        if not line.strip():
            continue
        res = classify_rich_rule(line)
        if res is None:
            continue
        kind, prio = res
        (accept_prios if kind == "accept" else block_prios).append(prio)

    if accept_prios and (not block_prios or min(accept_prios) < min(block_prios)):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
