import type { CSSProperties } from "react";
import { Check, Moon, Palette, RotateCcw, Sun } from "lucide-react";
import {
  defaultThemePreferences,
  resolveTheme,
  themePresets,
  useTheme,
  type ThemeMode,
  type ThemePreset,
} from "../../theme";

function ThemePreview({ preset }: { preset: ThemePreset }) {
  const style = {
    "--preview-bg": preset.background,
    "--preview-accent": preset.accent,
    "--preview-ink": preset.mode === "dark" ? "#ffffff" : "#000000",
  } as CSSProperties;

  return (
    <span className="theme-preview" style={style} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <i />
        <i />
        <i />
      </span>
      <span className="theme-preview-content">
        <i />
        <i />
        <span><i /><i /></span>
      </span>
    </span>
  );
}

export default function AppearanceSettings() {
  const { preferences, setPreferences, storageAvailable } = useTheme();
  const currentTheme = resolveTheme(preferences);
  const customTheme = resolveTheme({ ...preferences, presetId: "custom" });
  const customSelected = preferences.presetId === "custom";

  function changeCustomMode(mode: ThemeMode) {
    setPreferences((current) => ({
      ...current,
      presetId: "custom",
      customMode: mode,
      customBackground: customTheme.mode === mode
        ? current.customBackground
        : themePresets.find((preset) => preset.mode === mode)!.background,
    }));
  }

  return (
    <div className="appearance-settings">
      <div className="settings-section-heading">
        <Palette size={18} />
        <h3>外观与配色</h3>
      </div>
      <p className="appearance-description">
        选择适合你的工作环境的配色，修改即时生效。
      </p>
      <div className="appearance-current" role="status">
        <span className="appearance-color-dot" style={{ background: currentTheme.accent }} />
        <span>当前配色：{currentTheme.name}</span>
        <span>{currentTheme.mode === "dark" ? "深色" : "浅色"}</span>
      </div>

      {(["dark", "light"] as const).map((mode) => (
        <fieldset className="theme-group" key={mode}>
          <legend>
            {mode === "dark" ? <Moon size={15} /> : <Sun size={15} />}
            {mode === "dark" ? "深色方案" : "浅色方案"}
          </legend>
          <div className="theme-presets">
            {themePresets.filter((preset) => preset.mode === mode).map((preset) => {
              const selected = preferences.presetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`theme-preset${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => setPreferences((current) => ({ ...current, presetId: preset.id }))}
                >
                  <ThemePreview preset={preset} />
                  <span className="theme-preset-label">
                    <span>{preset.name}</span>
                    {selected && <Check size={15} aria-hidden="true" />}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <section className={`appearance-custom${customSelected ? " selected" : ""}`} aria-labelledby="custom-theme-heading">
        <div className="appearance-custom-heading">
          <h4 id="custom-theme-heading">自定义配色</h4>
          <button
            className="button button-small button-secondary"
            type="button"
            aria-pressed={customSelected}
            onClick={() => setPreferences((current) => ({
              ...current,
              presetId: "custom",
            }))}
          >
            {customSelected && <Check size={14} />}
            {customSelected ? "正在使用" : "使用自定义"}
          </button>
        </div>
        <div className="appearance-mode" aria-label="自定义配色模式">
          {(["dark", "light"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={customTheme.mode === mode}
              className={customTheme.mode === mode ? "active" : ""}
              onClick={() => changeCustomMode(mode)}
            >
              {mode === "dark" ? <Moon size={14} /> : <Sun size={14} />}
              {mode === "dark" ? "深色" : "浅色"}
            </button>
          ))}
        </div>
        <div className="appearance-color-fields">
          {([
            ["customBackground", "背景色"],
            ["customAccent", "强调色"],
          ] as const).map(([key, label]) => (
            <label className="appearance-color-field" key={key}>
              <input
                type="color"
                aria-label={`自定义${label}`}
                value={preferences[key]}
                onChange={(event) => setPreferences((current) => ({
                  ...current,
                  presetId: "custom",
                  [key]: event.target.value,
                }))}
              />
              <span>{label}<code>{preferences[key].toUpperCase()}</code></span>
            </label>
          ))}
        </div>
        <p className="appearance-hint">文字和界面层次将自动适配所选颜色。</p>
      </section>

      <div className="appearance-footer">
        <span>{storageAvailable ? "已自动保存在当前浏览器" : "当前浏览器无法保存，刷新后将恢复默认"}</span>
        <button
          type="button"
          className="text-button"
          onClick={() => setPreferences(defaultThemePreferences)}
        >
          <RotateCcw size={13} />恢复默认
        </button>
      </div>
    </div>
  );
}
