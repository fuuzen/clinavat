import { readFile } from 'node:fs/promises';

interface WorkspaceInstance { name: string; type?: string; status: string; state?: { pid?: number } }

/** Only a matching local cgroup proves that a managed container's PID belongs to this host. */
export async function workspaceCgroups(rows: WorkspaceInstance[], projectName: string,
  managed: (name: string) => boolean): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'container' || row.status !== 'Running' || !managed(row.name)) continue;
    const pid = row.state?.pid;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) continue;
    const project = projectName === 'default' ? '' : `${projectName}_`;
    const root = `/lxc.payload.${project}${row.name}`;
    const cgroups = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ESRCH'].includes(error.code ?? '')) return '';
      throw error;
    });
    const unified = cgroups.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (unified === root || unified?.startsWith(`${root}/`)) roots.add(root);
  }
  return roots;
}
