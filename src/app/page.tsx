'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_MODEL_ID, MODEL_METADATA, PUBLIC_MODEL_IDS, type PublicModelId } from '@/lib/modelCatalog';

type ThemeMode = 'light' | 'dark';

function initialTheme(fallback: ThemeMode): ThemeMode {
  try {
    const saved = window.localStorage.getItem('antigravity-theme');
    return saved === 'dark' || saved === 'light' ? saved : fallback;
  } catch {
    return fallback;
  }
}

function formatNumber(value: number) {
  return value.toLocaleString('en-US');
}

function ThemeToggle({ theme, onThemeChange }: { theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void }) {
  const toggleThemeMode = () => {
    onThemeChange(theme === 'light' ? 'dark' : 'light');
  };

  return (
    <button
      type="button"
      className="theme-switch"
      onClick={toggleThemeMode}
      aria-label={theme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
      aria-pressed={theme === 'dark'}
      data-theme-mode={theme}
      title={theme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
    >
      <span className="theme-switch-icon theme-switch-sun" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      </span>
      <span className="theme-switch-icon theme-switch-moon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M21 12.79A8.5 8.5 0 1 1 11.21 3 6.5 6.5 0 0 0 21 12.79Z" />
        </svg>
      </span>
      <span className="theme-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export default function LandingPage() {
  const [selectedModelId, setSelectedModelId] = useState<PublicModelId>(DEFAULT_MODEL_ID);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>('light');

  const selectedModel = useMemo(
    () => MODEL_METADATA[selectedModelId],
    [selectedModelId],
  );

  const config = useMemo(() => `model:
  default: ${selectedModelId}
  provider: custom
  base_url: http://localhost:18080/api/v1
  api_key: dummy_token
  context_length: ${selectedModel.contextLength}
  max_output_tokens: ${selectedModel.maxOutputTokens}`, [selectedModel, selectedModelId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTheme((currentTheme) => {
        const savedTheme = initialTheme(currentTheme);
        return savedTheme === currentTheme ? currentTheme : savedTheme;
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  const setThemeMode = (nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    try {
      window.localStorage.setItem('antigravity-theme', nextTheme);
    } catch (err) {
      console.warn('Failed to persist theme mode:', err);
    }
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.error('Failed to copy config:', err);
    }
  };

  return (
    <main className={`home-shell theme-${theme}`}>
      <div className="home-bg" aria-hidden="true" />

      <section className="home-frame">
        <header className="home-header">
          <div>
            <div className="home-kicker">OpenAI-compatible local pool</div>
            <h1>Antigravity Pool</h1>
          </div>
          <div className="home-actions">
            <ThemeToggle theme={theme} onThemeChange={setThemeMode} />
            <Link href="/admin/dashboard" className="primary-link">
              管理面板
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0-5 5m5-5H6" />
              </svg>
            </Link>
          </div>
        </header>

        <div className="home-grid">
          <section className="home-panel config-panel">
            <div className="panel-head">
              <div>
                <span>配置示例</span>
                <strong>{selectedModel.name}</strong>
              </div>
              <button type="button" onClick={copyConfig} className="copy-button">
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <pre>
              <code>{config}</code>
            </pre>
            <div className="model-facts">
              <div>
                <span>上下文</span>
                <strong>{formatNumber(selectedModel.contextLength)}</strong>
              </div>
              <div>
                <span>最大输出</span>
                <strong>{formatNumber(selectedModel.maxOutputTokens)}</strong>
              </div>
              <div>
                <span>上游</span>
                <strong>{selectedModel.provider}</strong>
              </div>
            </div>
          </section>

          <section className="home-panel model-panel">
            <div className="panel-head">
              <div>
                <span>可用模型</span>
                <strong>点击切换左侧配置</strong>
              </div>
            </div>
            <div className="model-list">
              {PUBLIC_MODEL_IDS.map((modelId) => {
                const model = MODEL_METADATA[modelId];
                return (
                  <button
                    key={modelId}
                    type="button"
                    data-model-id={modelId}
                    className={modelId === selectedModelId ? 'model-row active' : 'model-row'}
                    onClick={() => setSelectedModelId(modelId)}
                  >
                    <span>
                      <strong>{model.name}</strong>
                      <small>{modelId}</small>
                    </span>
                    <em>{model.mode}</em>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="home-steps">
          <div>
            <span>01</span>
            <strong>启动服务</strong>
            <code>npm run dev</code>
          </div>
          <div>
            <span>02</span>
            <strong>导入凭据</strong>
            <code>gemini:antigravity</code>
          </div>
          <div>
            <span>03</span>
            <strong>客户端地址</strong>
            <code>http://localhost:18080/api/v1</code>
          </div>
        </footer>
      </section>
    </main>
  );
}
