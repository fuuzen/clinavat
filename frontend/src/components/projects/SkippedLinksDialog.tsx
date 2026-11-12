import { Fragment, useState } from "react";
import { Folder, Link2 } from "lucide-react";
import type { Project, SkippedLinks } from "../../types";
import { Modal } from "../Dialogs";
import { groupByDirectory } from "./linkGroups";

interface Props {
  project: Project;
  skipped: SkippedLinks;
  onClose: () => void;
  /** Continues to the rules editor with these project paths added. */
  onExclude: (paths: string[]) => void;
}

const sides = { alpha: "开发机", beta: "镜像" };

export default function SkippedLinksDialog({ project, skipped, onClose, onExclude }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const groups = groupByDirectory(skipped.links);
  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <Modal title="未同步的软链接" subtitle={project.name} wide onClose={onClose}>
      <div className="modal-form">
        <p>
          同步只接受指向项目内的相对路径软链接。下列软链接的目标是绝对路径、指向项目外或格式无效，同步时被跳过，只存在于标注的一端；其他文件照常同步。
        </p>
        <div className="sync-scan">
          <div className="sync-scan-list">
            {groups.map(({ directory, items }) => {
              const wholeDirectory = !!directory && items.length > 1;
              return (
                <Fragment key={directory}>
                  {wholeDirectory && (
                    <label>
                      <input type="checkbox" checked={selected.has(directory)} onChange={() => toggle(directory)} />
                      <Folder size={14} />
                      <span className="sync-scan-path">{directory}/</span>
                      <span className="sync-scan-size">整个目录 · {items.length} 个</span>
                    </label>
                  )}
                  {items.map((link) => {
                    const covered = wholeDirectory && selected.has(directory);
                    return (
                      <label key={`${link.side}:${link.path}`} title={link.reason}>
                        <input
                          type="checkbox"
                          checked={covered || selected.has(link.path)}
                          disabled={covered}
                          onChange={() => toggle(link.path)}
                        />
                        <Link2 size={14} />
                        <span className="sync-scan-path">{link.path}</span>
                        <span className="sync-scan-tag">{sides[link.side]}</span>
                      </label>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
          <p className="form-hint">
            指向项目内的，建议改为相对路径软链接（ln -sfr 目标 链接名）；编译生成的，建议把所在的编译目录加入排除规则。
            {skipped.more > 0 && `另有 ${skipped.more} 个未列出。`}
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="button button-primary"
            disabled={!selected.size}
            onClick={() => onExclude([...selected])}
          >
            加入排除规则…
          </button>
        </div>
      </div>
    </Modal>
  );
}
