#!/usr/bin/python3 -I
"""Validate and render the independent proxy chains without exposing direct fallback."""
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlencode, urlsplit

DEFAULT_URL = 'https://www.gstatic.com/generate_204'
DEFAULT_INTERVAL = '30s'
MAX_GROUPS = 16
MAX_HOPS = 8
TAG = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
RESERVED = {'proxy', 'proxy-dns', 'direct', 'block', 'dns', 'tun-in', 'unbound'}
RESERVED_PREFIXES = ('src-', 'dns-', 'chain-')


def empty_preproxy():
    return {'nodes': [], 'groups': [], 'routes': {}}


def settings(state):
    return state.get('preproxy') or empty_preproxy()


def validate_preproxy(state, validate_nodes, error):
    value = state.get('preproxy', empty_preproxy())
    if not isinstance(value, dict) or set(value) - {'nodes', 'groups', 'routes'}:
        raise error('前置代理配置只允许 nodes / groups / routes 字段')
    nodes, groups, routes = value.get('nodes'), value.get('groups'), value.get('routes')
    front_tags = validate_nodes(nodes, minimum=0)
    egress_tags = {node['tag'] for node in state['nodes']}
    if egress_tags & front_tags:
        raise error(f'前置节点与出口节点标签重复：{", ".join(sorted(egress_tags & front_tags))}')
    if not isinstance(groups, list) or len(groups) > MAX_GROUPS:
        raise error(f'前置代理组最多 {MAX_GROUPS} 个')
    group_tags = set()
    normalized = []
    for group in groups:
        if not isinstance(group, dict) or set(group) - {'tag', 'nodes', 'url', 'interval', 'tolerance'}:
            raise error('前置代理组只允许 tag / nodes / url / interval / tolerance 字段')
        tag, members = group.get('tag'), group.get('nodes')
        if not isinstance(tag, str) or not TAG.fullmatch(tag) or tag in RESERVED or tag.startswith(RESERVED_PREFIXES):
            raise error(f'前置代理组标签无效或为保留名：{tag!r}')
        if tag in group_tags or tag in egress_tags or tag in front_tags:
            raise error(f'前置代理组标签重复：{tag}')
        group_tags.add(tag)
        if not isinstance(members, list) or not members or any(not isinstance(member, str) for member in members):
            raise error(f'前置代理组 {tag} 必须至少包含一个前置节点')
        if len(set(members)) != len(members) or set(members) - front_tags:
            raise error(f'前置代理组 {tag} 包含重复或不存在的前置节点')
        url = group.get('url', DEFAULT_URL)
        if not isinstance(url, str) or len(url) > 2048:
            raise error(f'前置代理组 {tag} 的探测地址必须是 HTTPS URL，且不能包含认证信息')
        try:
            parsed = urlsplit(url)
            valid_url = parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
            parsed.port
        except (TypeError, ValueError):
            valid_url = False
        if not valid_url:
            raise error(f'前置代理组 {tag} 的探测地址必须是 HTTPS URL，且不能包含认证信息')
        interval = group.get('interval', DEFAULT_INTERVAL)
        match = re.fullmatch(r'([1-9][0-9]*)(s|m|h)', interval) if isinstance(interval, str) else None
        seconds = int(match[1]) * {'s': 1, 'm': 60, 'h': 3600}[match[2]] if match else 0
        if not 10 <= seconds <= 3600:
            raise error(f'前置代理组 {tag} 的检查间隔必须在 10s 到 1h 之间')
        tolerance = group.get('tolerance', 50)
        if type(tolerance) is not int or not 0 <= tolerance <= 10000:
            raise error(f'前置代理组 {tag} 的切换容差必须为 0 到 10000 毫秒')
        normalized.append({'tag': tag, 'nodes': members, 'url': url, 'interval': interval, 'tolerance': tolerance})
    if not isinstance(routes, dict):
        raise error('前置代理路由必须是以出口节点标签为键的对象')
    groups_by_tag = {group['tag']: group for group in groups}
    for tag, route in routes.items():
        hops = route_hops(route)
        if tag not in egress_tags or not hops or len(hops) > MAX_HOPS:
            raise error(f'出口 {tag!r} 的前置链必须包含 1 到 {MAX_HOPS} 跳')
        seen = set()
        for hop in hops:
            if not isinstance(hop, str) or hop not in front_tags | group_tags:
                raise error(f'出口 {tag!r} 的前置跳 {hop!r} 不存在；只能引用前置节点或代理组')
            members = set(groups_by_tag[hop]['nodes']) if hop in group_tags else {hop}
            overlap = members & seen
            if overlap:
                raise error(f'出口 {tag!r} 的前置链重复使用节点或形成环路：{", ".join(sorted(overlap))}')
            seen.update(members)
    if 'preproxy' in state:
        state['preproxy'] = {'nodes': nodes, 'groups': normalized, 'routes': dict(sorted(routes.items()))}


def bootstrap_dns(infra):
    # Only proxy server names use this resolver. Client DNS still follows its bound exit.
    server = dict(infra.get('bootstrap_dns', infra['dns']))
    server.pop('detour', None)
    return {**server, 'tag': 'dns-bootstrap', 'bind_interface': infra['wan_if']}


def route_hops(route):
    return [route] if isinstance(route, str) else route if isinstance(route, list) else []


def clone_tag(exit_tag, index, original):
    exit_id = hashlib.sha256(exit_tag.encode()).hexdigest()[:16]
    node_id = hashlib.sha256(original.encode()).hexdigest()[:16]
    return f'chain-{exit_id}-{index + 1}-{node_id}'


def direct_front(node, infra):
    return {**node, 'bind_interface': infra['wan_if'], 'domain_resolver': 'dns-bootstrap'}


def automatic_group(group, tag=None, members=None):
    return {'type': 'urltest', 'tag': tag or group['tag'],
            'outbounds': members if members is not None else group['nodes'],
            'url': group.get('url', DEFAULT_URL), 'interval': group.get('interval', DEFAULT_INTERVAL),
            'tolerance': group.get('tolerance', 50), 'idle_timeout': '24h', 'interrupt_exist_connections': False}


def stage_node(node, tag, previous, infra):
    if previous is None:
        return {**direct_front(node, infra), 'tag': tag}
    outbound = {**node, 'tag': tag, 'detour': previous}
    outbound.pop('domain_resolver', None)
    return outbound


def render_chain(state, infra, target=None, isolated=False):
    value = settings(state)
    exits = [dict(node) for node in state['nodes'] if target is None or node['tag'] == target]
    front_by_tag = {node['tag']: node for node in value['nodes']}
    group_by_tag = {group['tag']: group for group in value['groups']}
    # Original names serve probes. Routed traffic gets an independent clone per exit and stage.
    front = [direct_front(node, infra) for node in value['nodes']] if target is None else []
    groups = [automatic_group(group) for group in value['groups']] if target is None else []
    for node in exits:
        previous = None
        for index, hop in enumerate(route_hops(value['routes'].get(node['tag']))):
            tag = clone_tag(node['tag'], index, hop)
            if hop in group_by_tag:
                group = group_by_tag[hop]
                members = []
                for member in group['nodes']:
                    member_tag = clone_tag(node['tag'], index, member)
                    front.append(stage_node(front_by_tag[member], member_tag, previous, infra))
                    members.append(member_tag)
                groups.append(automatic_group(group, tag, members))
            else:
                front.append(stage_node(front_by_tag[hop], tag, previous, infra))
            previous = tag
        if previous is not None:
            node['detour'] = previous
            # The preceding proxy receives this server hostname and resolves it remotely.
            node.pop('domain_resolver', None)
        elif isolated:
            node.update(bind_interface=infra['wan_if'], domain_resolver='dns-bootstrap')
    return {'nodes': exits, 'front': front, 'groups': groups,
            'dns': [bootstrap_dns(infra)] if front or isolated else []}


def proxy_revision(state):
    value = {'nodes': state['nodes'], 'preproxy': settings(state)}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def validate_masks(new, old, error):
    if isinstance(new, dict):
        for key, item in new.items():
            validate_masks(item, old.get(key) if isinstance(old, dict) else None, error)
    elif isinstance(new, list):
        for index, item in enumerate(new):
            validate_masks(item, old[index] if isinstance(old, list) and index < len(old) else None, error)
    elif new == '***' and (old is None or old == '***'):
        raise error('新节点的密钥字段不能为 ***；请填写密钥')


def merge_nodes(nodes, previous, merge_secret_fields, error):
    if not isinstance(nodes, list):
        raise error('代理节点必须是数组')
    merged = []
    for node in nodes:
        if not isinstance(node, dict):
            raise error('代理节点必须是对象')
        old = previous.get(node.get('tag'))
        validate_masks(node, old, error)
        item = merge_secret_fields(node, old)
        if contains_mask(item):
            raise error('新节点的密钥字段不能为 ***；请填写密钥')
        merged.append(item)
    return merged


def merge_preproxy(new, old, merge_secret_fields, error, previous=None):
    if not isinstance(new, dict):
        raise error('前置代理配置需要 nodes / groups / routes')
    previous = previous if previous is not None else {node['tag']: node for node in old.get('nodes', [])}
    return {**new, 'nodes': merge_nodes(new.get('nodes'), previous, merge_secret_fields, error)}


def replace_proxies(state, nodes, preproxy, merge_secret_fields, error):
    previous = {node['tag']: node for node in [*state['nodes'], *settings(state)['nodes']]}
    state['nodes'] = merge_nodes(nodes, previous, merge_secret_fields, error)
    state['preproxy'] = merge_preproxy(preproxy, settings(state), merge_secret_fields, error, previous)
    if state['nodes'] and state['selected'] not in {node['tag'] for node in state['nodes']}:
        state['selected'] = state['nodes'][0]['tag']
    return state


def contains_mask(value):
    if isinstance(value, dict):
        return any(contains_mask(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_mask(item) for item in value)
    return value == '***'


def preproxy_delay(state, infra, clash):
    value = settings(state)
    urls = {tag: group.get('url', DEFAULT_URL) for group in reversed(value['groups']) for tag in group['nodes']}
    result = {'nodes': {}, 'groups': {}, 'chains': {}, 'errors': {}}

    def delay(node):
        tag = node['tag']
        try:
            query = urlencode({'timeout': 5000, 'url': urls.get(tag, DEFAULT_URL)})
            value = clash(infra, 'GET', f'/proxies/{quote(tag, safe="")}/delay?{query}', timeout=8)
            return tag, value.get('delay'), None
        except Exception as error:
            return tag, None, str(error)[:200]

    with ThreadPoolExecutor(max_workers=16) as pool:
        for tag, milliseconds, error in pool.map(delay, value['nodes']):
            result['nodes'][tag] = milliseconds
            if error:
                result['errors'][tag] = error
    proxies = (clash(infra, 'GET', '/proxies', timeout=5) or {}).get('proxies', {}) if value['groups'] or value['routes'] else {}
    for group in value['groups']:
        result['groups'][group['tag']] = {'selected': proxies.get(group['tag'], {}).get('now'), 'nodes': group['nodes']}
    group_tags = {group['tag'] for group in value['groups']}
    for exit_tag, route in value['routes'].items():
        stages = []
        for index, hop in enumerate(route_hops(route)):
            runtime = proxies.get(clone_tag(exit_tag, index, hop), {})
            members = next((group['nodes'] for group in value['groups'] if group['tag'] == hop), [hop])
            selected = runtime.get('now') if hop in group_tags else clone_tag(exit_tag, index, hop) if runtime else None
            original = next((member for member in members if clone_tag(exit_tag, index, member) == selected), None)
            stages.append({'tag': hop, 'selected': original, 'nodes': members})
        result['chains'][exit_tag] = stages
    return result
