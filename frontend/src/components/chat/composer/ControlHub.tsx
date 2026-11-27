import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, LoaderCircle, MessageCircleQuestion } from "lucide-react";
import type { AgentBehavior, AgentProfile, PermissionMode, QuestionPolicy, QuestionPreference, Session } from "../../../types";
import type { AgentEngine } from "../../../engines";
import { PermissionMenuBody, selectedPermissionOption } from "../PermissionPicker";
import { BehaviorMenuBody, behaviorSummary, type OrchestrationLock } from "../native/BehaviorPicker";
import { QuestionPolicyMenuBody, questionPreferenceOf } from "../native/QuestionPolicyPicker";
import { durationLabel, policySummary, resolvePolicy } from "../native/questionPolicy";
import RadialWheel, { type ControlModuleId, type RadialSector } from "./RadialWheel";
import "../../../styles/control-wheel.css";

type HubView = "wheel" | ControlModuleId;

interface Position {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface Props {
  engine: AgentEngine;
  session?: Session;
  permissionMode: PermissionMode;
  permissionDisabled: boolean;
  permissionSaving: boolean;
  permissionOpenRequest?: number;
  clientHostWarning?: boolean;
  onPermissionChange: (mode: PermissionMode) => void;
  behavior: AgentBehavior;
  behaviorDisabled: boolean;
  behaviorSaving: boolean;
  behaviorOpenRequest?: number;
  orchestrationLock?: OrchestrationLock;
  roster?: { profiles: AgentProfile[]; session?: Session };
  onRollover?: () => void;
  onBehaviorChange: (value: AgentBehavior) => void;
  questionDefaults: QuestionPolicy;
  onQuestionsChange: (sessionId: string, value: QuestionPreference) => Promise<void>;
}

const panelWidths: Record<HubView, number> = {
  wheel: 276,
  permission: 244,
  behavior: 244,
  question: 320,
};

function enabledItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
  )).filter((item) => !item.matches(':disabled, [aria-disabled="true"], [hidden]'));
}

export default function ControlHub(props: Props) {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HubView>("wheel");
  const [position, setPosition] = useState<Position | null>(null);
  const [questionSaving, setQuestionSaving] = useState(false);

  const permissionSelected = selectedPermissionOption(props.engine, props.permissionMode);
  const PermissionIcon = permissionSelected.icon;
  const behaviorInfo = behaviorSummary(props.engine, props.behavior);
  const BehaviorIcon = behaviorInfo.icon;
  const effectiveQuestion = resolvePolicy(questionPreferenceOf(props.session), props.questionDefaults);

  const permissionLocked = props.permissionDisabled || props.permissionSaving;
  const behaviorLocked = props.behaviorDisabled || props.behaviorSaving;
  const questionLocked = !props.session || questionSaving;
  const allDisabled = permissionLocked && behaviorLocked && questionLocked;
  const anySaving = props.permissionSaving || props.behaviorSaving || questionSaving;

  const dismiss = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => dismiss(true), [dismiss]);

  const lastPermissionRequest = useRef(props.permissionOpenRequest);
  useEffect(() => {
    if (lastPermissionRequest.current === props.permissionOpenRequest) return;
    lastPermissionRequest.current = props.permissionOpenRequest;
    if (props.permissionOpenRequest && !permissionLocked) {
      setView("permission");
      setOpen(true);
    }
  }, [props.permissionOpenRequest, permissionLocked]);

  const lastBehaviorRequest = useRef(props.behaviorOpenRequest);
  useEffect(() => {
    if (lastBehaviorRequest.current === props.behaviorOpenRequest) return;
    lastBehaviorRequest.current = props.behaviorOpenRequest;
    if (props.behaviorOpenRequest && !behaviorLocked) {
      setView("behavior");
      setOpen(true);
    }
  }, [props.behaviorOpenRequest, behaviorLocked]);

  useEffect(() => {
    if (allDisabled) dismiss(false);
  }, [allDisabled, dismiss]);

  useLayoutEffect(() => {
    if (!open || allDisabled) return;
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (!popover || !trigger) return;
    function updatePosition() {
      if (!popover || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const vLeft = viewport?.offsetLeft || 0;
      const vTop = viewport?.offsetTop || 0;
      const vWidth = viewport?.width || window.innerWidth;
      const vHeight = viewport?.height || window.innerHeight;
      const gutter = 12;
      const gap = view === "wheel" ? 12 : 8;
      const desiredWidth = panelWidths[view];
      const width = Math.max(0, Math.min(desiredWidth, vWidth - gutter * 2));
      const above = Math.max(0, anchor.top - vTop - gap - gutter);
      const below = Math.max(0, vTop + vHeight - anchor.bottom - gap - gutter);
      const naturalHeight = view === "wheel" ? width : popover.scrollHeight + popover.offsetHeight - popover.clientHeight;
      const placeAbove = above >= Math.min(200, naturalHeight) || above >= below;
      const maxHeight = placeAbove ? above : below;
      const height = Math.min(naturalHeight, maxHeight);
      const preferredLeft = view === "wheel"
        ? anchor.left + anchor.width / 2 - width / 2
        : anchor.left;
      const next: Position = {
        top: Math.max(vTop + gutter, placeAbove ? anchor.top - gap - height : anchor.bottom + gap),
        left: Math.max(vLeft + gutter, Math.min(preferredLeft, vLeft + vWidth - gutter - width)),
        width,
        maxHeight,
      };
      setPosition((prev) => prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.maxHeight === next.maxHeight ? prev : next);
    }
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(popover);
    return () => observer.disconnect();
  }, [open, view, allDisabled]);

  useEffect(() => {
    if (!open) return;
    function containsTarget(target: EventTarget | null) {
      if (!(target instanceof Node)) return false;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return true;
      const element = target instanceof Element ? target : target.parentElement;
      return !!element?.closest<HTMLElement>("[data-settings-path]")?.dataset.settingsPath?.split(" ").includes(popoverId);
    }
    const outsidePointer = (event: PointerEvent) => { if (!containsTarget(event.target)) dismiss(false); };
    const outsideFocus = (event: FocusEvent) => { if (!containsTarget(event.target)) dismiss(false); };
    const outsideScroll = (event: Event) => { if (!containsTarget(event.target)) dismiss(false); };
    const onResize = () => dismiss(false);
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("focusin", outsideFocus, true);
    document.addEventListener("scroll", outsideScroll, true);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", outsideFocus, true);
      document.removeEventListener("scroll", outsideScroll, true);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
    };
  }, [open, dismiss, popoverId]);

  function panelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || view === "wheel") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (view === "question") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const popover = popoverRef.current;
    if (!popover) return;
    const items = enabledItems(popover);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;
    items[index]?.focus({ preventScroll: true });
  }

  const sectors: [RadialSector, RadialSector, RadialSector] = [
    {
      id: "permission",
      title: "授权模式",
      value: permissionSelected.label,
      hint: props.permissionSaving ? "正在保存" : "运行中不可调",
      icon: props.permissionSaving ? <LoaderCircle size={17} className="spin" /> : <PermissionIcon size={17} />,
      disabled: permissionLocked,
      className: `permission-${permissionSelected.value}`,
      accent: "var(--permission-color)",
    },
    {
      id: "behavior",
      title: "工作模式",
      value: behaviorInfo.label,
      hint: props.behaviorSaving ? "正在保存" : "运行中不可调",
      icon: props.behaviorSaving ? <LoaderCircle size={17} className="spin" /> : <BehaviorIcon size={17} />,
      disabled: behaviorLocked,
      className: behaviorInfo.highlighted ? "radial-sector-accented" : undefined,
      accent: "var(--accent)",
    },
    {
      id: "question",
      title: "提问等待",
      value: `${durationLabel(effectiveQuestion.timeoutMs)} · ${effectiveQuestion.mode === "skip" ? "跳过" : "待回答"}`,
      hint: !props.session ? "首条消息后可调" : "正在保存",
      icon: questionSaving ? <LoaderCircle size={17} className="spin" /> : <MessageCircleQuestion size={17} />,
      disabled: questionLocked,
      accent: "var(--info)",
    },
  ];

  const backButton = (
    <button
      type="button"
      className="icon-button control-panel-back"
      onClick={() => setView("wheel")}
      aria-label="返回控制转盘"
      title="返回控制转盘"
    >
      <ArrowLeft size={14} aria-hidden="true" />
    </button>
  );

  const summaryTitle = [
    `对话控制盘`,
    `授权：${permissionSelected.label}`,
    `模式：${behaviorInfo.title}`,
    `提问：${props.session ? policySummary(effectiveQuestion) : `默认（${policySummary(props.questionDefaults)}）`}`,
  ].join(" · ");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`settings-trigger control-hub-trigger permission-${permissionSelected.value}${behaviorInfo.highlighted ? " control-hub-accented" : ""}`}
        aria-label="对话控制盘（授权模式、工作模式、提问等待方式）"
        aria-haspopup="menu"
        aria-expanded={open && !allDisabled}
        aria-controls={open && !allDisabled ? popoverId : undefined}
        data-settings-path={popoverId}
        title={summaryTitle}
        disabled={allDisabled}
        onClick={() => {
          if (open) dismiss(false);
          else {
            setView("wheel");
            setOpen(true);
          }
        }}
      >
        <span className="control-hub-symbol permission-mode-symbol" aria-hidden="true">
          {anySaving ? <LoaderCircle size={15} className="spin" /> : <PermissionIcon size={15} />}
        </span>
        <span className="settings-trigger-label">控制盘</span>
        {behaviorInfo.shortTag && <span className="control-hub-badge">{behaviorInfo.shortTag}</span>}
        <ChevronDown size={12} className="settings-trigger-chevron" aria-hidden="true" />
      </button>

      {open && !allDisabled && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          className={view === "wheel" ? "control-wheel-popover" : "settings-menu control-panel-popover"}
          role={view === "question" ? "dialog" : "menu"}
          aria-label={view === "wheel" ? "对话控制转盘" : view === "permission" ? "授权模式" : view === "behavior" ? "工作模式与角色" : "提问的等待方式"}
          data-settings-path={popoverId}
          tabIndex={-1}
          onKeyDown={panelKeyDown}
          style={{
            position: "fixed",
            zIndex: 100,
            top: position?.top || 0,
            left: position?.left || 0,
            width: position?.width ?? Math.min(panelWidths[view], window.innerWidth - 24),
            maxHeight: position?.maxHeight ?? window.innerHeight - 24,
            overflowY: view === "wheel" ? "visible" : "auto",
            visibility: position ? "visible" : "hidden",
          }}
        >
          {view === "wheel" && (
            <RadialWheel
              sectors={sectors}
              onSelect={(moduleId) => setView(moduleId)}
              onClose={close}
            />
          )}
          {view === "permission" && (
            <PermissionMenuBody
              engine={props.engine}
              value={props.permissionMode}
              onChange={props.onPermissionChange}
              close={close}
              headingPrefix={backButton}
              clientHostWarning={props.clientHostWarning}
            />
          )}
          {view === "behavior" && (
            <BehaviorMenuBody
              engine={props.engine}
              value={props.behavior}
              orchestrationLock={props.orchestrationLock}
              roster={props.roster}
              onRollover={props.onRollover}
              onChange={props.onBehaviorChange}
              close={close}
              headingPrefix={backButton}
            />
          )}
          {view === "question" && (
            <QuestionPolicyMenuBody
              key={`${props.session?.id}:${props.session?.question_mode}:${props.session?.question_timeout_ms}`}
              session={props.session}
              defaults={props.questionDefaults}
              onChange={props.onQuestionsChange}
              onSavingChange={setQuestionSaving}
              close={close}
              headingPrefix={backButton}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
