'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { AccountSummary, RequestLogSummary } from '@/lib/types';

type ThemeMode = 'light' | 'dark';

function initialTheme(fallback: ThemeMode): ThemeMode {
  try {
    const saved = window.localStorage.getItem('antigravity-theme');
    return saved === 'dark' || saved === 'light' ? saved : fallback;
  } catch {
    return fallback;
  }
}

type MetricsData = {
  timestamp: string;
  last1h: {
    total429: number;
    totalRequests: number;
    errorRate: number;
    averageLatency: number;
    accounts: Array<{ name: string; count429: number; total: number; rate: number }>;
  };
  alert: {
    triggered: boolean;
    threshold: number;
    reason?: string;
  };
};

export default function AdminDashboard() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [logs, setLogs] = useState<RequestLogSummary[]>([]);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');

  // Form states
  const [name, setName] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [email, setEmail] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [accRes, metRes, logRes] = await Promise.all([
        fetch('/api/admin/accounts'),
        fetch('/api/admin/metrics'),
        fetch('/api/admin/logs')
      ]);
      if (accRes.ok) setAccounts(await accRes.json());
      if (metRes.ok) setMetrics(await metRes.json());
      if (logRes.ok) setLogs(await logRes.json());
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }, []);

  // Initial data load and periodic auto-refresh every 30s
  useEffect(() => {
    const refresh = () => {
      void loadData();
    };
    const initialLoad = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadData]);

  // Initialize theme from localStorage
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

  const doCleanup = async () => {
    setConfirmDialog(null);
    setCleaning(true);
    try {
      const res = await fetch('/api/admin/cleanup', { method: 'POST' });
      setSuccessMsg(res.ok ? '缓存清理任务已启动' : '启动缓存清理失败');
    } catch (err) {
      setErrorMsg(`请求失败: ${err}`);
    } finally {
      setCleaning(false);
    }
  };

  const handleCleanup = () => {
    setConfirmDialog({ message: '运行缓存清理，释放磁盘空间？', onConfirm: doCleanup });
  };

  const handleImportLocal = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    setImporting(true);

    try {
      const res = await fetch('/api/admin/accounts/import-local', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const accountId = typeof data?.account?.id === 'string' ? data.account.id : '';
        if (accountId) {
          setSuccessMsg(`${data.message || '本地 Active 凭据成功导入'}，正在自检...`);
          await checkHealth(accountId, 'import');
        } else {
          setSuccessMsg(data.message || '本地 Active 凭据成功导入');
          await loadData();
        }
      } else {
        setErrorMsg(data.error || '未能在本地找到可用凭据。请确保已登录并生成凭据。');
      }
    } catch (err) {
      setErrorMsg(`导入失败: ${err}`);
    } finally {
      setImporting(false);
    }
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!name.trim() || !refreshToken.trim()) {
      setErrorMsg('名称和 Refresh Token 不能为空');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, refreshToken, email: email || undefined }),
      });

      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`账户添加成功！${data.email ? `绑定邮箱: ${data.email}` : ''}`);
        setName('');
        setRefreshToken('');
        setEmail('');
        setShowAddModal(false);
        loadData();
      } else {
        setErrorMsg(data.error || '添加账户失败');
      }
    } catch (err) {
      setErrorMsg(`请求错误: ${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const doDeleteAccount = async (id: string) => {
    setConfirmDialog(null);
    try {
      const res = await fetch(`/api/admin/accounts/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSuccessMsg('账户已成功删除');
        loadData();
      } else {
        const err = await res.json();
        setErrorMsg(`删除失败: ${err.error || '未知错误'}`);
      }
    } catch (err) {
      setErrorMsg(`删除请求失败: ${err}`);
    }
  };

  const deleteAccount = (id: string) => {
    setConfirmDialog({ message: '确定删除此账户？', onConfirm: () => doDeleteAccount(id) });
  };

  const checkHealth = async (id: string, source: 'manual' | 'import' = 'manual') => {
    setCheckingId(id);
    if (source === 'manual') {
      setErrorMsg('');
      setSuccessMsg('');
    }

    try {
      const res = await fetch(`/api/admin/accounts/${id}/health`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(source === 'import' ? `导入完成，自检通过: ${data.message || 'ok'}` : `健康检查通过: ${data.message || 'ok'}`);
      } else {
        setErrorMsg(source === 'import' ? `导入成功，但自检失败: ${data.message || data.error || '错误'}` : `健康检查失败: ${data.message || data.error || '错误'}`);
      }
      await loadData();
    } catch (err) {
      setErrorMsg(source === 'import' ? `导入成功，但自检请求失败: ${err}` : `健康检查请求失败: ${err}`);
    } finally {
      setCheckingId(null);
    }
  };

  const active = accounts.filter((a) => a.status === 'active').length;
  const fallback = accounts.filter((a) => a.status === 'fallback').length;
  const exhausted = accounts.filter((a) => a.quotaStatus === 'exhausted').length;
  const invalid = accounts.filter((a) => a.status === 'invalid').length;

  const formatQuotaMessage = (msg: string) => {
    if (!msg) return '';
    try {
      const parsed = JSON.parse(msg);
      if (parsed.error) {
        return `${parsed.error.message || 'API Error'} (${parsed.error.code || parsed.error.status || 'Error'})`;
      }
      if (parsed.message) {
        return parsed.message;
      }
    } catch {
      // Not JSON
    }
    return msg;
  };

  return (
    <main className={`dashboard-shell theme-${theme} min-h-screen md:h-screen w-screen bg-slate-950 text-slate-100 font-sans md:overflow-hidden flex flex-col relative`}>
      {/* Background glowing gradients */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 right-1/4 w-[500px] h-[500px] rounded-full bg-indigo-900/10 blur-[120px]" />
        <div className="absolute bottom-10 left-10 w-[400px] h-[400px] rounded-full bg-purple-900/10 blur-[100px]" />
      </div>

      <div className="relative z-10 max-w-7xl w-full mx-auto px-4 py-6 md:py-5 flex-1 min-h-0 flex flex-col gap-5">
        {/* Header */}
        <div className="flex-none flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-800 pb-4 gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 bg-indigo-950 rounded-lg text-indigo-400 border border-indigo-800/40">
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(-30 12 12)" />
                  <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(30 12 12)" />
                  <circle cx="12" cy="12" r="2.5" fill="currentColor" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Antigravity Pool</h1>
            </div>
            <p className="text-sm text-slate-400 mt-1.5">Google/Gemini 账号流转池，自动获取及缓存访问令牌</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="theme-toggle" aria-label="Theme mode">
              <button
                type="button"
                className={theme === 'light' ? 'active' : ''}
                onClick={() => setThemeMode('light')}
                aria-label="亮色模式"
                aria-pressed={theme === 'light'}
                data-theme-mode="light"
                title="亮色模式"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'active' : ''}
                onClick={() => setThemeMode('dark')}
                aria-label="暗色模式"
                aria-pressed={theme === 'dark'}
                data-theme-mode="dark"
                title="暗色模式"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M21 12.79A8.5 8.5 0 1 1 11.21 3 6.5 6.5 0 0 0 21 12.79Z" />
                </svg>
              </button>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 hover:bg-slate-800 hover:text-white text-slate-300 px-4 py-2 text-sm font-medium shadow-sm transition active:scale-[0.97] text-center cursor-pointer select-none"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              添加账号
            </button>
            <button
              onClick={loadData}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 hover:bg-slate-800 hover:text-white text-slate-300 px-4 py-2 text-sm font-medium shadow-sm transition active:scale-[0.97] text-center cursor-pointer select-none"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M21 3v5h-5" />
              </svg>
              刷新数据
            </button>
            <button
              onClick={handleCleanup}
              disabled={cleaning}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 hover:bg-slate-800 hover:text-white text-slate-300 px-4 py-2 text-sm font-medium shadow-sm transition active:scale-[0.97] disabled:opacity-50 text-center cursor-pointer select-none"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {cleaning ? '清理中...' : '清理缓存'}
            </button>
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 hover:bg-slate-800 hover:text-white text-slate-300 px-4 py-2 text-sm font-medium transition active:scale-[0.97] text-center select-none"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              返回首页
            </Link>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="flex-none grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-5 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-center text-slate-500 text-xs font-bold uppercase tracking-wider">
              <span>总账号数</span>
              <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-white">{accounts.length}</span>
              <span className="text-xs text-slate-400 font-medium">个</span>
            </div>
            <div className="mt-4 flex gap-x-3 gap-y-1.5 text-[11px] text-slate-400 font-semibold flex-wrap">
              <span className="text-emerald-400 inline-flex items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5"></span>
                {active} 活跃
              </span>
              <span className="text-indigo-400 inline-flex items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mr-1.5"></span>
                {fallback} 备份
              </span>
              <span className="text-amber-400 inline-flex items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5"></span>
                {exhausted} 耗尽
              </span>
              <span className="text-rose-400 inline-flex items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mr-1.5"></span>
                {invalid} 失效
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-5 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-center text-slate-500 text-xs font-bold uppercase tracking-wider">
              <span>请求量 (1小时)</span>
              <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-white">{metrics?.last1h?.totalRequests ?? 0}</span>
              <span className="text-xs text-slate-400 font-medium">次</span>
            </div>
            <div className="mt-4 text-[11px] text-slate-500">最近一小时请求流转统计</div>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-5 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-center text-slate-500 text-xs font-bold uppercase tracking-wider">
              <span>平均延迟 (1小时)</span>
              <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-white">{metrics?.last1h?.averageLatency ?? 0}</span>
              <span className="text-xs text-slate-400 font-medium">ms</span>
            </div>
            <div className="mt-4 text-[11px] text-slate-500">直接基于 HTTPS API，无 CLI 延迟</div>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-5 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-center text-slate-500 text-xs font-bold uppercase tracking-wider">
              <span>异常率 (1小时)</span>
              <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className={`text-3xl font-bold ${metrics?.last1h?.errorRate && metrics.last1h.errorRate > 10 ? 'text-rose-400' : 'text-white'}`}>
                {metrics?.last1h?.errorRate ?? 0}%
              </span>
              <span className="text-xs text-slate-400 font-medium">({metrics?.last1h?.total429 ?? 0} 次 429)</span>
            </div>
            <div className="mt-4 text-[11px] text-slate-500">自动过滤和锁定配额已耗尽的账号</div>
          </div>
        </div>

        {/* Messages */}
        {successMsg && (
          <div className="flex-none rounded-lg bg-emerald-950/40 border border-emerald-800/50 p-3.5 text-xs text-emerald-300 flex items-center gap-2 backdrop-blur-sm shadow-inner">
            <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{successMsg}</span>
          </div>
        )}
        {errorMsg && (
          <div className="flex-none rounded-lg bg-rose-950/40 border border-rose-800/50 p-3.5 text-xs text-rose-300 flex items-center gap-2 backdrop-blur-sm shadow-inner">
            <svg className="w-4 h-4 text-rose-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Accounts List (Full Width) */}
        <div className="flex-1 md:min-h-0 rounded-xl border border-slate-800 bg-slate-900/30 shadow-2xl overflow-hidden flex flex-col backdrop-blur-md">
          <div className="px-5 py-3 border-b border-slate-800/60 bg-slate-900/50 flex justify-between items-center flex-none">
            <h2 className="font-semibold text-slate-200 text-sm">池内可用账户列表 ({accounts.length})</h2>
            <button
              onClick={handleImportLocal}
              disabled={importing}
              className="inline-flex items-center text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition disabled:opacity-50 gap-1 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
              </svg>
              {importing ? '导入中...' : '导入本地 Active 凭据'}
            </button>
          </div>

          {accounts.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center text-slate-500 text-sm bg-transparent">
              账户池目前为空，请点击右上角添加账号或导入本地凭证。
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              <table className="w-full border-collapse text-left text-xs relative">
                <thead className="sticky top-0 bg-slate-900/90 z-10 border-b border-slate-800 shadow-[0_1px_0_0_rgba(30,41,59,1)] backdrop-blur-md">
                  <tr className="font-semibold text-slate-400 uppercase tracking-wider">
                    <th className="px-5 py-3.5 bg-slate-900/20">账号名称</th>
                    <th className="px-5 py-3.5 bg-slate-900/20">状态</th>
                    <th className="px-5 py-3.5 bg-slate-900/20">配额状态</th>
                    <th className="px-5 py-3.5 bg-slate-900/20">调用次数</th>
                    <th className="px-5 py-3.5 text-right bg-slate-900/20">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {accounts.map((acc) => (
                    <tr key={acc.id} className="group hover:bg-slate-900/40 transition-all duration-200">
                      <td className="px-5 py-4">
                        <div className="font-semibold text-slate-200 group-hover:text-indigo-400 transition-colors duration-200">{acc.name}</div>
                        {acc.email && <div className="text-[10px] text-slate-500 mt-0.5">{acc.email}</div>}
                        {acc.status !== 'active' && acc.quotaMessage && (
                          <div className="text-[10px] text-rose-400/90 mt-1 max-w-[360px] truncate flex items-center gap-1.5" title={acc.quotaMessage}>
                            <svg className="w-3 h-3 text-rose-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span>诊断信息: {formatQuotaMessage(acc.quotaMessage)}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                          acc.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                          acc.status === 'exhausted' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                          acc.status === 'fallback' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' :
                          'bg-rose-500/10 text-rose-400 border-rose-500/20'
                        }`}>
                          {acc.status}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                          acc.quotaStatus === 'available' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                          acc.quotaStatus === 'exhausted' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                          'bg-slate-800 text-slate-400 border-slate-700'
                        }`}>
                          {acc.quotaStatus === 'available' ? '有配额' : acc.quotaStatus === 'exhausted' ? '额度耗尽' : '未知'}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-mono text-slate-400 font-semibold">{acc.usageCount}</td>
                      <td className="px-5 py-4 text-right">
                        <div className="inline-flex items-center justify-end gap-3.5">
                          <button
                            type="button"
                            onClick={() => checkHealth(acc.id)}
                            disabled={checkingId === acc.id}
                            className="inline-flex items-center text-[11px] font-bold text-indigo-400 hover:text-indigo-300 transition active:scale-95 disabled:opacity-50 gap-1 cursor-pointer select-none"
                          >
                            <svg className={`w-3.5 h-3.5 ${checkingId === acc.id ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M21 3v5h-5" />
                            </svg>
                            {checkingId === acc.id ? '自检中...' : '自检'}
                          </button>
                          <span className="w-px h-3 bg-slate-800" />
                          <button
                            type="button"
                            onClick={() => deleteAccount(acc.id)}
                            className="inline-flex items-center text-[11px] font-bold text-rose-400 hover:text-rose-300 transition active:scale-95 gap-1 cursor-pointer select-none"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent Logs Card (Full Width) */}
        <div className="h-[180px] flex-none rounded-xl border border-slate-800 bg-slate-900/30 shadow-2xl overflow-hidden flex flex-col backdrop-blur-md">
          <div className="px-5 py-3 border-b border-slate-800/60 bg-slate-900/50 flex-none">
            <h2 className="font-semibold text-slate-200 text-sm flex items-center gap-1.5">
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              最近请求日志 (最近 10 次)
            </h2>
          </div>
          {logs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-500 bg-transparent gap-2 select-none">
              <svg className="w-8 h-8 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-xs font-semibold text-slate-500">暂无请求日志</span>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              <table className="w-full border-collapse text-left text-xs relative">
                <thead className="sticky top-0 bg-slate-900/90 z-10 border-b border-slate-800 shadow-[0_1px_0_0_rgba(30,41,59,1)] backdrop-blur-md">
                  <tr className="font-semibold text-slate-400 uppercase tracking-wider bg-slate-900/10">
                    <th className="px-5 py-3">请求时间</th>
                    <th className="px-5 py-3">使用账号</th>
                    <th className="px-5 py-3">模型</th>
                    <th className="px-5 py-3">响应延迟</th>
                    <th className="px-5 py-3">状态码</th>
                    <th className="px-5 py-3">错误信息</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 font-mono text-slate-400">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-900/30 transition">
                      <td className="px-5 py-3 text-slate-500">
                        {new Date(log.timestamp).toLocaleString('zh-CN', { hour12: false })}
                      </td>
                      <td className="px-5 py-3 font-sans text-slate-300 font-semibold">
                        {log.account?.name || '未知'}
                      </td>
                      <td className="px-5 py-3 text-indigo-400">{log.model}</td>
                      <td className="px-5 py-3">{log.latency} ms</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          log.statusCode === 200 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                        }`}>
                          {log.statusCode}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-rose-400/95 max-w-[250px] truncate" title={log.error || ''}>
                        {log.error || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Add Account Modal */}
        {/* Confirm Dialog */}
        {confirmDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-xl border border-slate-850 bg-slate-900 p-6 shadow-2xl space-y-4 relative">
              <p className="text-slate-200 text-sm">{confirmDialog.message}</p>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setConfirmDialog(null)}
                  className="w-1/2 rounded-lg border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 shadow-sm transition hover:bg-slate-750 cursor-pointer"
                >
                  取消
                </button>
                <button
                  onClick={confirmDialog.onConfirm}
                  className="w-1/2 rounded-lg bg-rose-600 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 cursor-pointer"
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        )}

        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-xl border border-slate-850 bg-slate-900 p-6 shadow-2xl space-y-4 relative">
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setErrorMsg('');
                  setSuccessMsg('');
                }}
                className="absolute top-4 right-4 text-slate-500 hover:text-slate-300 transition p-1.5 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <h2 className="font-bold text-white text-base flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                添加 Google 账号
              </h2>
              
              <form onSubmit={handleAddAccount} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">账号备注名</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如: 备用账号-01"
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none text-slate-100 placeholder-slate-600"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Refresh Token (必填)</label>
                  <textarea
                    required
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder="输入授权捕获的 Refresh Token"
                    rows={3}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none font-mono text-slate-100 placeholder-slate-600"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">邮箱 (选填)</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="不填将由 Token 自动解析"
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none text-slate-100 placeholder-slate-600"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddModal(false);
                      setErrorMsg('');
                      setSuccessMsg('');
                    }}
                    className="w-1/2 rounded-lg border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 shadow-sm transition hover:bg-slate-750 cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-1/2 rounded-lg bg-indigo-600 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
                  >
                    {submitting ? '保存中...' : '保存至账户池'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
