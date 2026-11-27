/** The slot shares its hook files across runs. Project and permission settings come from each CLI process. */
export const hookProgram = String.raw`
import fcntl
import json
import os
import re
import shlex
import sys

READ_PATH_FIELDS = {
    'read_file': ('Path', 'AbsolutePath', 'FilePath'),
    'view_file': ('AbsolutePath', 'Path'),
    'view_file_outline': ('AbsolutePath', 'Path'),
    'grep_search': ('SearchPath', 'SearchDirectory', 'Path'),
    'find_by_name': ('SearchDirectory', 'SearchPath', 'Path'),
    'list_dir': ('DirectoryPath', 'Path'),
}
WRITE_PATH_FIELDS = ('Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'DirectoryPath')
DIRECT_BRAIN_READ_TOOLS = {'read_file', 'view_file', 'view_file_outline'}
DIRECT_BRAIN_WRITE_TOOLS = {'write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'}
PROTECTED = {'.bin', '.git', '.claude', '.codex', '.gemini', '.clinavat', '.system_generated'}
SHORT_NAME_RE = re.compile(r'^\.?(?:git|bin)~\d+(?:\..*)?$', re.IGNORECASE)
INVISIBLE_RE = re.compile(r'[\u200b-\u200f\u202a-\u202e\u2060\u206a-\u206f\ufeff]')
WIN_DRIVE_RE = re.compile(r'^([A-Za-z]):[\\/](.*)$')
MCP_TOOL_RE = re.compile(r'^(?:mcp[_:./]+)?clinavat[_:./]+[a-z_]+$')
DIRECT_SAFE_TOOLS = {'ask_question', 'search_web'}

def is_windows_mirrored():
    if os.environ.get('CLINAVAT_AGY_CLIENT_MODE') != 'mirrored':
        return False
    plat = (os.environ.get('CLINAVAT_AGY_CLIENT_PLATFORM') or '').strip().lower()
    return plat in ('win32', 'windows') or plat.startswith('win')

def is_protected_segment(segment, check_ads=False):
    cleaned = INVISIBLE_RE.sub('', segment)
    if check_ads and ':' in cleaned:
        return True
    base = cleaned.split(':', 1)[0]
    lower = base.lower()
    stripped = lower.rstrip('. ')
    if lower in PROTECTED or stripped in PROTECTED:
        return True
    return bool(SHORT_NAME_RE.match(base))

def assert_basic_path(value):
    if not isinstance(value, str) or not value or '\0' in value or '\r' in value or '\n' in value:
        raise ValueError('工具缺少有效的项目路径')
    if value.startswith('\\\\') or value.startswith('//'):
        raise ValueError('不支持 UNC 网络路径')

def assert_safe_relative_segments(rel, win_mode):
    if rel == '.':
        return
    segs = re.split(r'[\\/]+', rel) if win_mode else rel.split(os.sep)
    for seg in segs:
        if not seg:
            continue
        if (win_mode and seg == '..') or is_protected_segment(seg, check_ads=win_mode):
            raise ValueError('不能访问受保护的工作区、ADS、8.3 短名或 Git 内部目录')

def map_windows_path(value):
    assert_basic_path(value)
    win_mode = is_windows_mirrored()
    if not win_mode:
        return (value, False)
    m = WIN_DRIVE_RE.match(value)
    if not m:
        if re.match(r'^[A-Za-z]:', value):
            raise ValueError('Windows 路径格式无效或超出项目目录')
        return (value, False)
    client_root = os.environ.get('CLINAVAT_AGY_CLIENT_ROOT') or ''
    vm_root = (os.environ.get('CLINAVAT_AGY_VM_ROOT') or os.environ.get('CLINAVAT_AGY_ROOT') or '').rstrip('/')
    rm = WIN_DRIVE_RE.match(client_root)
    if not rm or not vm_root:
        raise ValueError('缺少客户端项目路径映射配置')
    if m.group(1).lower() != rm.group(1).lower():
        raise ValueError('路径盘符与项目目录不一致')
    root_segs = [s for s in re.split(r'[\\/]+', rm.group(2)) if s and s != '.']
    raw_segs = [s for s in re.split(r'[\\/]+', m.group(2)) if s and s != '.']
    if '..' in raw_segs:
        raise ValueError('路径不能包含上级目录回溯（..）')
    if len(raw_segs) < len(root_segs):
        raise ValueError('只允许访问当前项目目录内的路径')
    for left, right in zip(root_segs, raw_segs):
        if left.lower() != right.lower():
            raise ValueError('只允许访问当前项目目录内的路径')
    rel_segs = raw_segs[len(root_segs):]
    for seg in rel_segs:
        if is_protected_segment(seg, check_ads=True):
            raise ValueError('不能访问受保护的工作区、ADS、8.3 短名或 Git 内部目录')
    mapped = vm_root + ('/' + '/'.join(rel_segs) if rel_segs else '')
    return (mapped, True)

def path_targets(cwd, value):
    candidate = os.path.join(cwd, os.path.expanduser(value))
    return (os.path.abspath(candidate), os.path.realpath(candidate))

def in_brain(targets):
    brain = os.environ.get('CLINAVAT_AGY_BRAIN_ROOT')
    if not brain:
        return (False, False)
    lexical = os.path.abspath(brain)
    try:
        # Reject when BRAIN_ROOT itself is a symlink, while allowing legitimate symlinked OS ancestors (e.g. /home -> /var/home).
        if os.path.islink(lexical):
            return (os.path.commonpath((lexical, targets[0])) == lexical, False)
        root = os.path.realpath(lexical)
        in_lexical = (
            os.path.commonpath((lexical, targets[0])) == lexical
            or os.path.commonpath((root, targets[0])) == root
        )
        in_real = os.path.commonpath((root, targets[1])) == root
        return (in_lexical, in_real)
    except ValueError:
        return (False, False)

def validate_path(root, cwd, value, allow_brain=False, write_root=None):
    mapped, rewritten = map_windows_path(value)
    targets = path_targets(cwd, mapped)
    brain = in_brain(targets)
    if any(brain):
        if not allow_brain or not all(brain) or os.environ['CLINAVAT_AGY_ACCESS'] == 'super':
            raise ValueError('不能跨越 brain 目录边界或在 Super 模式下读取该目录')
        if os.path.commonpath((root, *targets)) != root:
            return (mapped, rewritten)
    win_mode = is_windows_mirrored()
    check_root = write_root or root
    for target in targets:
        if os.path.commonpath((check_root, target)) != check_root:
            raise ValueError('只允许访问当前允许的项目目录内路径')
        assert_safe_relative_segments(os.path.relpath(target, root), win_mode)
    return (mapped, rewritten)

def validate_read(payload, tool, arguments):
    mode = os.environ['CLINAVAT_AGY_MODE']
    if mode in ('off', 'overview'):
        raise ValueError(os.environ['CLINAVAT_AGY_READ_DENIAL'])
    root = os.path.realpath(os.environ['CLINAVAT_AGY_ROOT'])
    cwd = payload.get('cwd') or os.environ['CLINAVAT_AGY_CWD']
    mapped_cwd, _ = validate_path(root, root, cwd)
    cwd = os.path.join(root, mapped_cwd)
    path_fields = READ_PATH_FIELDS[tool]
    overwrite = {}
    found_path = False
    for key in path_fields:
        if key in arguments:
            found_path = True
            mapped, rewritten = validate_path(root, cwd, arguments[key], allow_brain=True)
            if rewritten:
                overwrite[key] = mapped
    if not found_path:
        raise ValueError('工具缺少有效的项目路径')
    if arguments.get('FollowSymlinks') or arguments.get('FollowLinks'):
        raise ValueError('搜索不能跟随符号链接')
    win_mode = is_windows_mirrored()
    for key in ('Pattern', 'Includes', 'Excludes'):
        patterns = arguments.get(key, [])
        for pattern in patterns if isinstance(patterns, list) else [patterns]:
            if not isinstance(pattern, str):
                raise ValueError('搜索模式无效')
            pattern = pattern.lstrip('!')
            parts = pattern.replace('\\', '/').split('/')
            if os.path.isabs(pattern) or '..' in parts or any(is_protected_segment(p, check_ads=win_mode) for p in parts if p):
                raise ValueError('搜索模式必须位于当前项目目录内')
    if mode == 'full':
        counter = os.environ['CLINAVAT_AGY_READ_COUNTER']
        limit = int(os.environ['CLINAVAT_AGY_READ_LIMIT'])
        descriptor = os.open(counter, os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'r+') as state:
            fcntl.flock(state, fcntl.LOCK_EX)
            calls = int(state.read(32))
            if calls >= limit:
                raise ValueError('本轮原生读取和搜索已达 %s 次，请委派 explorer 子智能体。' % limit)
            state.seek(0)
            state.write(str(calls + 1))
            state.truncate()
    return overwrite

def validate_write(payload, arguments):
    root = os.path.realpath(os.environ['CLINAVAT_AGY_ROOT'])
    agent_dir = (os.environ.get('CLINAVAT_AGY_AGENT_DIR') or '').strip()
    write_root = os.path.realpath(os.path.join(root, agent_dir)) if agent_dir else root
    cwd = payload.get('cwd') or os.environ['CLINAVAT_AGY_CWD']
    mapped_cwd, _ = validate_path(root, root, cwd)
    cwd = os.path.join(root, mapped_cwd)
    overwrite = {}
    for key in WRITE_PATH_FIELDS:
        if key in arguments and arguments[key] is not None:
            mapped, rewritten = validate_path(root, cwd, arguments[key], allow_brain=True, write_root=write_root)
            if rewritten:
                overwrite[key] = mapped
    return overwrite

def direct_paths_in_brain(payload, paths):
    if not paths:
        return False
    cwd = payload.get('cwd') or os.environ.get('CLINAVAT_AGY_CWD') or '/'
    for value in paths:
        try:
            assert_basic_path(value)
            targets = path_targets(cwd, value)
        except Exception:
            return False
        if not all(in_brain(targets)):
            return False
    return True

def direct_decision(payload, call):
    name = str(call.get('name') or '').strip()
    if MCP_TOOL_RE.match(name) or name in DIRECT_SAFE_TOOLS:
        return {'decision': 'allow'}
    arguments = call.get('args') or {}
    access = os.environ.get('CLINAVAT_AGY_ACCESS') or 'write'
    if name in DIRECT_BRAIN_READ_TOOLS and access != 'super':
        paths = [arguments[key] for key in READ_PATH_FIELDS[name] if key in arguments and arguments[key] is not None]
        if direct_paths_in_brain(payload, paths):
            return {'decision': 'allow'}
    if name in DIRECT_BRAIN_WRITE_TOOLS and access not in ('super', 'read'):
        paths = [arguments[key] for key in WRITE_PATH_FIELDS if key in arguments and arguments[key] is not None]
        if direct_paths_in_brain(payload, paths):
            return {'decision': 'allow'}
    if access == 'super':
        return {'decision': 'deny', 'reason': '当前为客户端直连模式的 Super Agent，已禁用本地工具；请使用 mcp_clinavat_inspect 或通过 mcp_clinavat_start_agent 委派子智能体。'}
    if access == 'read':
        return {'decision': 'deny', 'reason': '当前为客户端直连只读模式，已禁用本地内置工具；请使用 mcp_clinavat_client_read_file / mcp_clinavat_client_list_dir / mcp_clinavat_client_glob / mcp_clinavat_client_grep。'}
    return {'decision': 'deny', 'reason': '当前为客户端直连模式，已禁用本地内置工具；请使用 mcp_clinavat_client_* 工具（如 mcp_clinavat_client_read_file、mcp_clinavat_client_write_file、mcp_clinavat_client_edit_file、mcp_clinavat_client_apply_patch、mcp_clinavat_client_exec_command 等）。'}

def tool_decision(payload, mode):
    call = payload.get('toolCall') or {}
    arguments = call.get('args') or {}
    if mode == 'direct':
        return direct_decision(payload, call)
    if mode == 'read':
        overwrite = validate_read(payload, call.get('name'), arguments)
        return {'decision': 'allow', **({'overwrite': overwrite} if overwrite else {})}
    access = os.environ['CLINAVAT_AGY_ACCESS']
    if access == 'super':
        raise ValueError('Super Agent 请通过 clinavat 工具委派文件修改和命令执行。')
    if mode == 'write':
        if access == 'read':
            raise ValueError('你是只读子智能体，请在最终回复中说明需要的修改。')
        overwrite = validate_write(payload, arguments)
        return {'decision': 'allow', **({'overwrite': overwrite} if overwrite else {})}
    shell = os.environ.get('CLINAVAT_AGY_SHELL')
    root = os.path.realpath(os.environ['CLINAVAT_AGY_ROOT'])
    overwrite = {}
    directory = payload.get('cwd') or os.environ.get('CLINAVAT_AGY_CWD') or '.'
    if 'Cwd' in arguments and arguments['Cwd'] is not None:
        mapped_arg_cwd, rewritten_cwd = validate_path(root, root, arguments['Cwd'])
        directory = mapped_arg_cwd
        if rewritten_cwd:
            overwrite['Cwd'] = mapped_arg_cwd
    else:
        mapped_dir, _ = validate_path(root, root, directory)
        directory = mapped_dir
    if not shell:
        return {'decision': 'ask', **({'overwrite': overwrite} if overwrite else {})}
    command = arguments.get('CommandLine')
    if not isinstance(command, str):
        raise ValueError('missing command')
    background = ' --background' if arguments.get('IsDaemon') is True else ''
    routed = 'cd %s && %s%s -c %s' % (shlex.quote(directory), shlex.quote(shell), background, shlex.quote(command))
    overwrite['CommandLine'] = routed
    return {'decision': 'ask', 'overwrite': overwrite}

mode = sys.argv[1]
try:
    payload = json.load(sys.stdin)
    if mode == 'btw-gate':
        if os.environ.get('CLINAVAT_AGY_BTW') == '1':
            print(json.dumps({'decision': 'deny', 'reason': '旁路提问（/btw）为只读问答模式，禁止调用任何工具。请直接基于已有上下文回答。'}))
        else:
            # agy requires a decision and denies without one; "allow" hands the call on to the next hook and the default policy.
            print(json.dumps({'decision': 'allow'}))
    elif mode == 'stop':
        fields = ('conversationId', 'fullyIdle', 'terminationReason')
        with open(sys.argv[2], 'a') as log:
            log.write(json.dumps({key: payload.get(key) for key in fields}) + '\n')
        print('{}')
    elif mode == 'deny':
        print(json.dumps({'decision': 'deny', 'reason': sys.argv[2]}))
    else:
        print(json.dumps(tool_decision(payload, mode)))
except Exception as error:
    print(json.dumps({'decision': 'deny', 'reason': 'Clinavat: %s' % error}))
`;
