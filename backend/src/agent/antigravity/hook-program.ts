/** The slot shares its hook files across runs. Project and permission settings come from each CLI process. */
export const hookProgram = String.raw`
import fcntl
import json
import os
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
PROTECTED = {'.bin', '.git', '.claude', '.codex', '.gemini', '.clinavat', '.system_generated'}

def validate_path(root, cwd, value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError('工具缺少有效的项目路径')
    candidate = os.path.join(cwd, os.path.expanduser(value))
    for target in (os.path.abspath(candidate), os.path.realpath(candidate)):
        if os.path.commonpath((root, target)) != root:
            raise ValueError('只允许读取项目内的路径')
        if PROTECTED.intersection(os.path.relpath(target, root).split(os.sep)):
            raise ValueError('不能读取工作区或槽位内部文件')

def validate_read(payload, tool, arguments):
    mode = os.environ['CLINAVAT_AGY_MODE']
    if mode in ('off', 'overview'):
        raise ValueError(os.environ['CLINAVAT_AGY_READ_DENIAL'])
    root = os.path.realpath(os.environ['CLINAVAT_AGY_ROOT'])
    cwd = payload.get('cwd') or os.environ['CLINAVAT_AGY_CWD']
    validate_path(root, root, cwd)
    cwd = os.path.join(root, cwd)
    path_fields = READ_PATH_FIELDS[tool]
    paths = [arguments[key] for key in path_fields if key in arguments]
    if not paths:
        raise ValueError('工具缺少有效的项目路径')
    for value in paths:
        validate_path(root, cwd, value)
    if arguments.get('FollowSymlinks') or arguments.get('FollowLinks'):
        raise ValueError('搜索不能跟随符号链接')
    for key in ('Pattern', 'Includes', 'Excludes'):
        patterns = arguments.get(key, [])
        for pattern in patterns if isinstance(patterns, list) else [patterns]:
            if not isinstance(pattern, str):
                raise ValueError('搜索模式无效')
            pattern = pattern.lstrip('!')
            parts = pattern.replace('\\', '/').split('/')
            if os.path.isabs(pattern) or '..' in parts or PROTECTED.intersection(parts):
                raise ValueError('搜索模式必须位于当前项目目录内')
    if mode == 'full':
        # Several PreToolUse hooks may run concurrently inside one prompt.
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

def tool_decision(payload, mode):
    call = payload.get('toolCall') or {}
    arguments = call.get('args') or {}
    if mode == 'read':
        validate_read(payload, call.get('name'), arguments)
        return {'decision': 'allow'}
    access = os.environ['CLINAVAT_AGY_ACCESS']
    if access == 'super':
        raise ValueError('Super Agent 请通过 clinavat 工具委派文件修改和命令执行。')
    if mode == 'write':
        if access == 'read':
            raise ValueError('你是只读子智能体，请在最终回复中说明需要的修改。')
        return {'decision': 'allow'}
    shell = os.environ.get('CLINAVAT_AGY_SHELL')
    if not shell:
        return {'decision': 'ask'}
    command = arguments.get('CommandLine')
    if not isinstance(command, str):
        raise ValueError('missing command')
    background = ' --background' if arguments.get('IsDaemon') is True else ''
    directory = payload.get('cwd') or '.'
    routed = 'cd %s && %s%s -c %s' % (shlex.quote(directory), shlex.quote(shell), background, shlex.quote(command))
    return {'decision': 'ask', 'overwrite': {'CommandLine': routed}}

mode = sys.argv[1]
try:
    payload = json.load(sys.stdin)
    if mode == 'stop':
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
