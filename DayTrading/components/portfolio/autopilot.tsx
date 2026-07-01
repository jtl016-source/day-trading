// ── AUTOPILOT — automated DCA into index ETFs (Alpaca) ───────────────────────
// "Buy me stocks for longevity, like Autopilot." Connects to Alpaca (paper by
// default), dollar-cost-averages a fixed amount across target ETFs on a schedule,
// and shows the live paper/real account + accumulated positions. Server does the
// actual buying on a 5-min scheduler (server/portfolio/alpaca.ts).
import { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Trading, Fonts } from '@/constants/theme';
import { usePortfolioApi, usePortfolioPost, fmtMoney, fmtNum } from '@/hooks/use-portfolio';
import { Panel, Empty } from './portfolio-ui';

interface Alloc { ticker: string; weight: number; }
interface Cfg {
  enabled: boolean; mode: 'paper' | 'live';
  amountPerRun: number; cadence: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  dayOfWeek: number; dayOfMonth: number; allocations: Alloc[];
  lastRunISO: string | null; keyIdMasked: string; hasKeys: boolean; usingEnvKeys: boolean;
}
interface Account { status: string; cash: number; equity: number; buyingPower: number; portfolioValue: number; }
interface Position { ticker: string; qty: number; marketValue: number; unrealizedPl: number; unrealizedPlPct: number; }
interface Order { id: string; ts: string; ticker: string; notional: number; status: string; error?: string; mode: string; trigger: string; }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CADENCES: Cfg['cadence'][] = ['daily', 'weekly', 'biweekly', 'monthly'];

export function Autopilot() {
  const cfgApi = usePortfolioApi<{ config: Cfg }>('/api/portfolio/autopilot/config');
  const acctApi = usePortfolioApi<{ account: Account | null; error?: string }>('/api/portfolio/autopilot/account', 60000);
  const posApi = usePortfolioApi<{ positions: Position[] }>('/api/portfolio/autopilot/positions', 60000);
  const ordApi = usePortfolioApi<{ orders: Order[] }>('/api/portfolio/autopilot/orders', 60000);
  const post = usePortfolioPost();

  const [draft, setDraft] = useState<Cfg | null>(null);
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { if (cfgApi.data?.config && !draft) setDraft(cfgApi.data.config); }, [cfgApi.data]);

  if (!draft) return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={Trading.accent} /></View>;

  const cfg = draft;
  const totalWeight = cfg.allocations.reduce((a, x) => a + (x.weight || 0), 0) || 1;
  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 6000); };

  const saveCfg = async (patch: Partial<Cfg>, creds?: boolean) => {
    const next = { ...cfg, ...patch };
    setDraft(next);
    setBusy('save');
    try {
      const body: any = {
        enabled: next.enabled, mode: next.mode, amountPerRun: next.amountPerRun,
        cadence: next.cadence, dayOfWeek: next.dayOfWeek, dayOfMonth: next.dayOfMonth,
        allocations: next.allocations,
      };
      if (creds) { body.keyId = keyId.trim(); body.secretKey = secret.trim(); }
      const r = await post('/api/portfolio/autopilot/config', body);
      if (r?.config) setDraft(r.config);
      if (creds) { setKeyId(''); setSecret(''); }
      flash(true, 'Saved');
      acctApi.refetch();
    } catch (e: any) { flash(false, String(e?.message ?? e)); }
    finally { setBusy(null); }
  };

  const testKeys = async () => {
    setBusy('test');
    try {
      const r = await post('/api/portfolio/autopilot/test', { keyId: keyId.trim(), secretKey: secret.trim(), mode: cfg.mode });
      flash(!!r?.ok, r?.ok ? `Connected — account ${r.status} (${r.mode})` : `Failed: ${r?.error ?? 'unknown'}`);
    } catch (e: any) { flash(false, String(e?.message ?? e)); }
    finally { setBusy(null); }
  };

  const runNow = () => {
    const go = async () => {
      setBusy('run');
      try {
        const r = await post('/api/portfolio/autopilot/run', {});
        const ok = (r?.orders ?? []).filter((o: Order) => o.status !== 'error' && o.status !== 'skipped').length;
        flash(true, `Submitted ${ok}/${(r?.orders ?? []).length} orders`);
        ordApi.refetch(); posApi.refetch(); acctApi.refetch();
      } catch (e: any) { flash(false, String(e?.message ?? e)); }
      finally { setBusy(null); }
    };
    if (cfg.mode === 'live') {
      Alert.alert('Run LIVE contribution?', `This buys $${cfg.amountPerRun} of real ETFs now.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Buy now', style: 'destructive', onPress: go },
      ]);
    } else { go(); }
  };

  const setAlloc = (i: number, patch: Partial<Alloc>) => {
    const allocations = cfg.allocations.map((a, j) => (j === i ? { ...a, ...patch } : a));
    setDraft({ ...cfg, allocations });
  };
  const addAlloc = () => setDraft({ ...cfg, allocations: [...cfg.allocations, { ticker: '', weight: 0 }] });
  const delAlloc = (i: number) => setDraft({ ...cfg, allocations: cfg.allocations.filter((_, j) => j !== i) });

  const acct = acctApi.data?.account ?? null;
  const positions = posApi.data?.positions ?? [];
  const orders = ordApi.data?.orders ?? [];

  return (
    <View>
      {/* ── Status / connection ── */}
      <Panel title="Autopilot — Index DCA" right={
        <View style={[s.modeBadge, cfg.mode === 'live' ? s.live : s.paper]}>
          <Text style={[s.modeTxt, { color: cfg.mode === 'live' ? Trading.short : Trading.accent }]}>{cfg.mode.toUpperCase()}</Text>
        </View>
      }>
        {!cfg.hasKeys ? (
          <>
            <Text style={s.note}>Connect Alpaca to enable automated buying. Use a PAPER key first (fake money) — get one free at alpaca.markets → Paper Trading → API Keys.</Text>
            <Text style={s.lab}>API KEY ID</Text>
            <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} placeholder="PK..." placeholderTextColor={Trading.dim} value={keyId} onChangeText={setKeyId} />
            <Text style={s.lab}>API SECRET</Text>
            <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="••••••••" placeholderTextColor={Trading.dim} value={secret} onChangeText={setSecret} />
            <View style={s.btnRow}>
              <Pressable style={s.btn} onPress={testKeys} disabled={busy === 'test' || !keyId || !secret}>
                <Text style={s.btnTxt}>{busy === 'test' ? 'Testing…' : 'Test'}</Text>
              </Pressable>
              <Pressable style={[s.btn, s.primary]} onPress={() => saveCfg({}, true)} disabled={busy === 'save' || !keyId || !secret}>
                <Text style={[s.btnTxt, { color: Trading.accent }]}>Save keys</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={s.kv}><Text style={s.k}>Connected key</Text><Text style={s.v}>{cfg.keyIdMasked || (cfg.usingEnvKeys ? 'env' : '—')}</Text></View>
            {acct ? (
              <>
                <View style={s.kv}><Text style={s.k}>Account</Text><Text style={s.v}>{acct.status}</Text></View>
                <View style={s.statRow}>
                  <Stat label="EQUITY" value={fmtMoney(acct.equity)} />
                  <Stat label="CASH" value={fmtMoney(acct.cash)} />
                  <Stat label="BUYING PWR" value={fmtMoney(acct.buyingPower)} />
                </View>
              </>
            ) : (
              <Text style={[s.note, { color: Trading.amber }]}>{acctApi.data?.error ? `Account error: ${acctApi.data.error}` : 'Loading account…'}</Text>
            )}
            {/* paper/live switch */}
            <View style={s.segRow}>
              {(['paper', 'live'] as const).map((m) => (
                <Pressable key={m} style={[s.seg, cfg.mode === m && (m === 'live' ? s.segLive : s.segOn)]} onPress={() => saveCfg({ mode: m })}>
                  <Text style={[s.segTxt, cfg.mode === m && { color: m === 'live' ? Trading.short : Trading.accent }]}>{m === 'paper' ? 'PAPER (safe)' : 'LIVE $'}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </Panel>

      {cfg.hasKeys && (
        <>
          {/* ── Plan ── */}
          <Panel title="Contribution Plan" right={
            <Pressable onPress={() => saveCfg({ enabled: !cfg.enabled })}>
              <View style={[s.toggle, cfg.enabled && s.toggleOn]}><View style={[s.knob, cfg.enabled && s.knobOn]} /></View>
            </Pressable>
          }>
            <Text style={s.note}>{cfg.enabled ? 'ON — buys automatically on schedule.' : 'OFF — schedule paused. You can still Run now.'}</Text>

            <Text style={s.lab}>AMOUNT PER CONTRIBUTION ($)</Text>
            <TextInput style={s.input} keyboardType="numeric" value={String(cfg.amountPerRun)} placeholderTextColor={Trading.dim}
              onChangeText={(t) => setDraft({ ...cfg, amountPerRun: Math.max(0, parseFloat(t) || 0) })}
              onEndEditing={() => saveCfg({})} />

            <Text style={s.lab}>CADENCE</Text>
            <View style={s.segRow}>
              {CADENCES.map((c) => (
                <Pressable key={c} style={[s.seg, cfg.cadence === c && s.segOn]} onPress={() => saveCfg({ cadence: c })}>
                  <Text style={[s.segTxt, cfg.cadence === c && { color: Trading.accent }]}>{c.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>

            {(cfg.cadence === 'weekly' || cfg.cadence === 'biweekly') && (
              <>
                <Text style={s.lab}>DAY OF WEEK</Text>
                <View style={s.segRow}>
                  {[1, 2, 3, 4, 5].map((d) => (
                    <Pressable key={d} style={[s.seg, cfg.dayOfWeek === d && s.segOn]} onPress={() => saveCfg({ dayOfWeek: d })}>
                      <Text style={[s.segTxt, cfg.dayOfWeek === d && { color: Trading.accent }]}>{DOW[d]}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            {cfg.cadence === 'monthly' && (
              <>
                <Text style={s.lab}>DAY OF MONTH (1–28)</Text>
                <TextInput style={s.input} keyboardType="numeric" value={String(cfg.dayOfMonth)} placeholderTextColor={Trading.dim}
                  onChangeText={(t) => setDraft({ ...cfg, dayOfMonth: Math.max(1, Math.min(28, parseInt(t) || 1)) })}
                  onEndEditing={() => saveCfg({})} />
              </>
            )}

            {/* allocations */}
            <View style={[s.kv, { marginTop: 10 }]}>
              <Text style={s.lab}>ETF ALLOCATIONS (weights)</Text>
              <Pressable onPress={addAlloc}><Text style={s.addTxt}>+ Add</Text></Pressable>
            </View>
            {cfg.allocations.map((a, i) => {
              const dollars = cfg.amountPerRun * ((a.weight || 0) / totalWeight);
              return (
                <View key={i} style={s.allocRow}>
                  <TextInput style={[s.input, s.allocTk]} autoCapitalize="characters" placeholder="VOO" placeholderTextColor={Trading.dim}
                    value={a.ticker} onChangeText={(t) => setAlloc(i, { ticker: t.toUpperCase() })} onEndEditing={() => saveCfg({})} />
                  <TextInput style={[s.input, s.allocWt]} keyboardType="numeric" placeholder="0" placeholderTextColor={Trading.dim}
                    value={String(a.weight)} onChangeText={(t) => setAlloc(i, { weight: Math.max(0, parseFloat(t) || 0) })} onEndEditing={() => saveCfg({})} />
                  <Text style={s.allocDol}>{fmtMoney(dollars)}</Text>
                  <Pressable onPress={() => { delAlloc(i); }} hitSlop={8}><Text style={s.del}>✕</Text></Pressable>
                </View>
              );
            })}
            {!cfg.allocations.length && <Empty text="ADD AT LEAST ONE ETF" />}

            <Pressable style={[s.runBtn, cfg.mode === 'live' && s.runLive]} onPress={runNow} disabled={busy === 'run' || !cfg.allocations.length}>
              <Text style={[s.runTxt, cfg.mode === 'live' && { color: Trading.short }]}>
                {busy === 'run' ? 'Submitting…' : `Run now — buy ${fmtMoney(cfg.amountPerRun)} (${cfg.mode})`}
              </Text>
            </Pressable>
            {cfg.lastRunISO && <Text style={s.lastRun}>Last run {new Date(cfg.lastRunISO).toLocaleString()}</Text>}
          </Panel>

          {/* ── Positions ── */}
          <Panel title="Holdings (Alpaca)">
            {!positions.length && <Empty text="NO POSITIONS YET" />}
            {positions.map((p) => (
              <View key={p.ticker} style={s.posRow}>
                <Text style={s.posTk}>{p.ticker}</Text>
                <Text style={s.posQty}>{fmtNum(p.qty, 4)} sh</Text>
                <Text style={s.posVal}>{fmtMoney(p.marketValue)}</Text>
                <Text style={[s.posPl, { color: p.unrealizedPl >= 0 ? Trading.long : Trading.short }]}>
                  {p.unrealizedPl >= 0 ? '+' : ''}{fmtNum(p.unrealizedPlPct, 1)}%
                </Text>
              </View>
            ))}
          </Panel>

          {/* ── Recent automated buys ── */}
          <Panel title="Recent Buys">
            {!orders.length && <Empty text="NO ORDERS YET" />}
            {orders.slice(0, 12).map((o) => (
              <View key={o.id} style={s.ordRow}>
                <Text style={s.ordTk}>{o.ticker}</Text>
                <Text style={s.ordAmt}>{fmtMoney(o.notional)}</Text>
                <Text style={[s.ordStatus, { color: o.status === 'error' ? Trading.short : o.status === 'skipped' ? Trading.amber : Trading.long }]}>{o.status}</Text>
                <Text style={s.ordWhen}>{o.trigger === 'manual' ? 'manual' : 'auto'} · {new Date(o.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</Text>
              </View>
            ))}
          </Panel>
        </>
      )}

      {msg && (
        <View style={[s.toast, { borderColor: msg.ok ? 'rgba(31,217,138,0.5)' : 'rgba(255,77,109,0.5)' }]}>
          <Text style={[s.toastTxt, { color: msg.ok ? Trading.long : Trading.short }]}>{msg.text}</Text>
        </View>
      )}
      <Text style={s.disclaimer}>Automated investing involves risk. Paper mode uses simulated money. Not investment advice.</Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}><Text style={s.statLab}>{label}</Text><Text style={s.statVal}>{value}</Text></View>
  );
}

const s = StyleSheet.create({
  modeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 7, borderWidth: 1 },
  paper: { backgroundColor: 'rgba(45,212,191,0.12)', borderColor: 'rgba(45,212,191,0.4)' },
  live: { backgroundColor: 'rgba(255,77,109,0.12)', borderColor: 'rgba(255,77,109,0.45)' },
  modeTxt: { fontFamily: Fonts.mono, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  note: { fontSize: 12, color: Trading.muted, lineHeight: 17, marginBottom: 10 },
  lab: { fontSize: 10, letterSpacing: 1.2, color: Trading.muted, marginBottom: 6, marginTop: 6 },
  input: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Trading.line, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9, color: Trading.text, fontFamily: Fonts.mono, fontSize: 13, marginBottom: 8 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: Trading.line },
  primary: { backgroundColor: 'rgba(45,212,191,0.14)', borderColor: 'rgba(45,212,191,0.4)' },
  btnTxt: { fontFamily: Fonts.display, fontSize: 12, fontWeight: '600', color: Trading.muted },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  k: { color: Trading.muted, fontSize: 12 },
  v: { color: Trading.text, fontFamily: Fonts.mono, fontSize: 12 },
  statRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  stat: { flex: 1, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: Trading.line, borderRadius: 9, padding: 9 },
  statLab: { fontSize: 8, letterSpacing: 1, color: Trading.muted },
  statVal: { fontFamily: Fonts.mono, fontSize: 14, color: Trading.text, marginTop: 3, fontWeight: '600' },
  segRow: { flexDirection: 'row', gap: 6, marginBottom: 4, flexWrap: 'wrap' },
  seg: { flex: 1, minWidth: 56, alignItems: 'center', paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  segOn: { borderColor: 'rgba(45,212,191,0.4)', backgroundColor: 'rgba(45,212,191,0.14)' },
  segLive: { borderColor: 'rgba(255,77,109,0.45)', backgroundColor: 'rgba(255,77,109,0.12)' },
  segTxt: { fontFamily: Fonts.mono, fontSize: 11, fontWeight: '600', color: Trading.muted },
  toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: Trading.line, padding: 2, justifyContent: 'center' },
  toggleOn: { backgroundColor: 'rgba(45,212,191,0.3)', borderColor: 'rgba(45,212,191,0.5)' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#9aa0aa' },
  knobOn: { backgroundColor: Trading.accent, alignSelf: 'flex-end' },
  addTxt: { color: Trading.accent, fontFamily: Fonts.display, fontSize: 12, fontWeight: '600' },
  allocRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  allocTk: { flex: 1.2, marginBottom: 6 },
  allocWt: { flex: 0.7, marginBottom: 6, textAlign: 'center' },
  allocDol: { flex: 1, textAlign: 'right', color: Trading.muted, fontFamily: Fonts.mono, fontSize: 12 },
  del: { color: Trading.short, fontSize: 16, paddingHorizontal: 4 },
  runBtn: { marginTop: 12, alignItems: 'center', paddingVertical: 13, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(45,212,191,0.4)', backgroundColor: 'rgba(45,212,191,0.14)' },
  runLive: { borderColor: 'rgba(255,77,109,0.5)', backgroundColor: 'rgba(255,77,109,0.14)' },
  runTxt: { fontFamily: Fonts.display, fontSize: 13, fontWeight: '700', color: Trading.accent, letterSpacing: 0.5 },
  lastRun: { fontSize: 10, color: Trading.dim, fontFamily: Fonts.mono, textAlign: 'center', marginTop: 8 },
  posRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  posTk: { flex: 1, color: Trading.text, fontWeight: '600', fontFamily: Fonts.display, fontSize: 13 },
  posQty: { flex: 1, textAlign: 'right', color: Trading.muted, fontFamily: Fonts.mono, fontSize: 11 },
  posVal: { flex: 1, textAlign: 'right', color: Trading.text, fontFamily: Fonts.mono, fontSize: 11 },
  posPl: { flex: 0.8, textAlign: 'right', fontFamily: Fonts.mono, fontSize: 11 },
  ordRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  ordTk: { flex: 1, color: Trading.text, fontWeight: '600', fontFamily: Fonts.display, fontSize: 12 },
  ordAmt: { flex: 0.8, textAlign: 'right', color: Trading.text, fontFamily: Fonts.mono, fontSize: 11 },
  ordStatus: { flex: 1, textAlign: 'right', fontFamily: Fonts.mono, fontSize: 11 },
  ordWhen: { flex: 1.1, textAlign: 'right', color: Trading.dim, fontFamily: Fonts.mono, fontSize: 10 },
  toast: { marginTop: 12, padding: 11, borderRadius: 10, borderWidth: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  toastTxt: { fontFamily: Fonts.mono, fontSize: 12, textAlign: 'center' },
  disclaimer: { fontFamily: Fonts.mono, fontSize: 9, color: Trading.dim, textAlign: 'center', marginTop: 12, lineHeight: 13 },
});
