import { useEffect, useRef } from 'react';
import { Command, FileText, Folder, LoaderCircle } from 'lucide-react';
import type { CompletionOption } from './useComposerCompletion';

interface Props {
  id: string;
  kind?: 'command' | 'path';
  options: CompletionOption[];
  selectedIndex: number;
  loading: boolean;
  error: string;
  truncated: boolean;
  onSelect: (index: number) => void;
}
export default function CompletionMenu(props: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [props.selectedIndex]);
  return <div className="composer-completion">
    <div className="completion-heading"><span>{props.kind === 'command' ? '快捷指令' : '引用项目文件'}</span><span>↑↓ 选择 · Tab 补全 · Esc 关闭</span></div>
    <div ref={listRef} id={props.id} role="listbox" aria-label={props.kind === 'command' ? 'Slash Commands' : '项目路径'} className="completion-options">
      {props.options.map((option, index) => {
        const Icon = option.type === 'command' ? Command : option.type === 'directory' ? Folder : FileText;
        return <button key={option.key} id={`${props.id}-${index}`} type="button" role="option" tabIndex={-1}
          aria-selected={index === props.selectedIndex} className="completion-option"
          onMouseDown={event => event.preventDefault()} onClick={() => props.onSelect(index)}>
          <Icon size={15} aria-hidden="true" /><span><strong>{option.label}</strong><small>{option.description}</small></span>
        </button>;
      })}
    </div>
    {props.loading && <div className="completion-message" role="status"><LoaderCircle size={14} className="spin" />正在查找文件…</div>}
    {props.error && <div className="completion-message completion-error" role="status">{props.error}</div>}
    {!props.loading && !props.error && !props.options.length && <div className="completion-message" role="status">{props.kind === 'command' ? '没有匹配的指令，输入 / 查看支持的命令' : '没有匹配的项目文件，请检查路径'}</div>}
    {props.kind === 'path' && props.truncated && <div className="completion-message">仅显示部分结果，输入更完整的目录或文件名缩小范围</div>}
  </div>;
}
