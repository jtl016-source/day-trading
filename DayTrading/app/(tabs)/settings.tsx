import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useApp, type ExitStrategy } from '@/context/app-context';
import { useTradeStatus } from '@/hooks/use-trade-status';
import { normalizeSymbol } from '@/hooks/use-market-data';
import { Card, Row, Toggle, Seg, Stepper } from '@/components/meridian-ui';
import { LayersIcon, SettingsIcon, MarketIcon, SignalIcon } from '@/components/meridian-icons';
import { Trading, Fonts } from '@/constants/theme';

const SYMBOLS = ['MES', 'ES', 'MNQ'] as const;

// ── AutoTrader card — arm/disarm + contract config, inlined to match the PC ───────
function AutoTraderInline({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [connected, setConnected] = useState(false);
  const [hasActiveTrade, setHasActiveTrade] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [contractType, setContractType] = useState<'MES' | 'ES'>('MES');
  const [contracts, setContracts] = useState(1);
  const [tp1Only, setTp1Only] = useState(false);
  const [direction, setDirection] = useState<'both' | 'long' | 'short'>('both');
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try { const r = await fetch(`${apiBaseUrl}/api/trade/status`); const d = await r.json(); if (alive) setConnected(!!d.connected); } catch { if (alive) setConnected(false); }
      try { const r2 = await fetch(`${apiBaseUrl}/api/trade/current`); const d2 = await r2.json(); if (alive) setHasActiveTrade(!!(d2.trade && d2.trade.status === 'open')); } catch {}
    };
    fetch(`${apiBaseUrl}/api/trade/settings`).then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (typeof d.enabled === 'boolean') setEnabled(d.enabled);
      if (d.contractType === 'MES' || d.contractType === 'ES') setContractType(d.contractType);
      if (typeof d.contracts === 'number') setContracts(d.contracts);
      if (typeof d.tp1Only === 'boolean') setTp1Only(d.tp1Only);
      if (d.direction === 'both' || d.direction === 'long' || d.direction === 'short') setDirection(d.direction);
    }).catch(() => {});
    poll(); const id = setInterval(poll, 5000); return () => { alive = false; clearInterval(id); };
  }, [apiBaseUrl]);

  const save = (patch: Record<string, unknown>) => {
    setSyncing(true);
    fetch(`${apiBaseUrl}/api/trade/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      .catch(() => {}).finally(() => setSyncing(false));
  };
  const toggleArm = () => {
    if (!connected || syncing) return;
    const next = !enabled;
    setSyncing(true);
    fetch(`${apiBaseUrl}/api/trade/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) })
      .then(() => setEnabled(next)).catch(() => {}).finally(() => setSyncing(false));
  };

  const armState = !enabled ? 'OFF' : !connected ? 'OFF' : hasActiveTrade ? 'LIVE' : 'ARMED';
  const armColor = armState === 'LIVE' ? Trading.long : armState === 'ARMED' ? '#ffb454' : Trading.muted;

  return (
    <Card title="AutoTrader" icon={<SettingsIcon size={14} color={Trading.accent} />}>
      <View style={[s.armBanner, { borderColor: armColor + '55', backgroundColor: armColor + '14' }]}>
        <View style={s.inline}>
          <View style={[s.dot, { backgroundColor: armColor }]} />
          <Text style={[s.armState, { color: armColor }]}>{armState}</Text>
          {armState === 'ARMED' && <Text style={[s.armSub, { color: armColor }]}>{contractType} · {contracts}c</Text>}
          {armState === 'LIVE' && <Text style={[s.armSub, { color: armColor }]}>trade open</Text>}
        </View>
        <Pressable onPress={toggleArm} disabled={!connected || syncing}
          style={[s.armBtn, { borderColor: armColor + '88', backgroundColor: enabled ? armColor + '22' : 'transparent' }]}>
          <Text style={[s.armBtnTxt, { color: connected ? armColor : Trading.muted }]}>
            {syncing ? '…' : enabled ? 'DISARM' : (connected ? 'ARM' : 'NOT CONNECTED')}
          </Text>
        </Pressable>
      </View>

      <Row label="Contract" sub={contractType === 'MES' ? '$5 / pt' : '$50 / pt'}>
        <Seg value={contractType} options={['MES', 'ES'] as const}
          onChange={(v) => { setContractType(v); save({ contractType: v }); }} />
      </Row>
      <Row label="Contracts per trade">
        <Stepper value={contracts} step={1} min={1} max={10}
          onChange={(v) => { setContracts(v); save({ contracts: v }); }} fmt={(v) => `${v}`} />
      </Row>
      <Row label="Direction">
        <Seg value={direction} options={['both', 'long', 'short'] as const}
          labels={{ both: 'Both', long: 'Long', short: 'Short' }}
          onChange={(v) => { setDirection(v); save({ direction: v }); }} />
      </Row>
      <Row label="Exit mode" last>
        <Seg value={tp1Only ? 'TP1' : 'TP1+TP2'} options={['TP1', 'TP1+TP2'] as const}
          onChange={(v) => { const t = v === 'TP1'; setTp1Only(t); save({ tp1Only: t }); }} />
      </Row>

      {enabled && <Text style={s.warn}>⚠ AUTO TRADE ON — LIVE ORDERS WILL BE PLACED</Text>}
    </Card>
  );
}

// Mirror of the PC terminal Settings (client/src/components/terminal/SettingsView.tsx):
// Contract · Exit Strategy · Signal Engine · Machine Learning · AutoTrader · Discord Bot.
// The endpoint + push cards are iPhone-only (the PC is same-origin and has no push).
export default function SettingsScreen() {
  const {
    instrument, setInstrument,
    apiBaseUrl, setApiBaseUrl,
    notificationsEnabled, setNotificationsEnabled,
    exitStrategy, setExitStrategy,
    terminal, setTerminal,
  } = useApp();
  const { connected } = useTradeStatus();

  const [urlInput, setUrlInput] = useState(apiBaseUrl);
  const symBase = normalizeSymbol(instrument);

  // Push the AutoTrader-relevant fields to the engine so they behave exactly like the PC.
  const syncTrade = (patch: Record<string, unknown>) => {
    fetch(`${apiBaseUrl}/api/trade/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => {});
  };

  const saveUrl = () => {
    const trimmed = urlInput.trim().replace(/\/$/, '');
    setApiBaseUrl(trimmed);
    Alert.alert('Saved', 'Endpoint updated.');
  };

  // ── Discord webhook (server-stored, same endpoint as the PC) ──────────────────
  const [discordWebhook, setDiscordWebhook] = useState('');
  const [discordState, setDiscordState] = useState<'idle' | 'saving' | 'saved'>('idle');
  useEffect(() => {
    let alive = true;
    fetch(`${apiBaseUrl}/api/discord/settings`)
      .then((r) => r.json())
      .then((d) => { if (alive && typeof d?.webhook === 'string') setDiscordWebhook(d.webhook); })
      .catch(() => {});
    return () => { alive = false; };
  }, [apiBaseUrl]);
  const saveDiscord = () => {
    setDiscordState('saving');
    fetch(`${apiBaseUrl}/api/discord/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook: discordWebhook.trim() }),
    })
      .then(() => { setDiscordState('saved'); setTimeout(() => setDiscordState('idle'), 2000); })
      .catch(() => setDiscordState('idle'));
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.titleBar}><Text style={s.title}>SETTINGS</Text></View>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* ── CONTRACT ──────────────────────────────────────────────────────── */}
          <Card title="Contract" icon={<LayersIcon size={14} color={Trading.accent} />}>
            <Row label="Symbol" last>
              <Seg value={(SYMBOLS.includes(symBase as any) ? symBase : 'MES') as typeof SYMBOLS[number]}
                options={SYMBOLS} onChange={(v) => setInstrument(`${v}1!`)} />
            </Row>
          </Card>

          {/* ── EXIT STRATEGY ─────────────────────────────────────────────────── */}
          <Card title="Exit Strategy" icon={<SignalIcon size={14} color={Trading.accent} />}>
            <Row label="Profile" sub="Tight 4/28 · Std 5/20 · Wide 10/30">
              <Seg value={(exitStrategy === 'current' ? 'standard' : exitStrategy) as Exclude<ExitStrategy, 'current'>}
                options={['tight', 'standard', 'wide'] as const}
                labels={{ tight: 'Tight', standard: 'Std', wide: 'Wide' }}
                onChange={(v) => setExitStrategy(v)} />
            </Row>
            <Row label="Direction">
              <Seg value={terminal.direction} options={['both', 'long', 'short'] as const}
                labels={{ both: 'Both', long: 'Long', short: 'Short' }}
                onChange={(v) => { setTerminal('direction', v); syncTrade({ direction: v }); }} />
            </Row>
            <Row label="Targets" sub="TP1 only, or TP1 + TP2">
              <Seg value={terminal.tp1Only ? 'TP1' : 'TP1+TP2'} options={['TP1', 'TP1+TP2'] as const}
                onChange={(v) => { const t = v === 'TP1'; setTerminal('tp1Only', t); syncTrade({ tp1Only: t }); }} />
            </Row>
            <Row label="Trailer Stop" sub={terminal.useTrailer ? `trails ${terminal.trailerOffset}pt after TP1` : 'fixed TP1 + TP2 bracket'}>
              <View style={s.inline}>
                {terminal.useTrailer && (
                  <Stepper value={terminal.trailerOffset} step={0.25} min={0.25} max={10}
                    onChange={(v) => setTerminal('trailerOffset', v)} fmt={(v) => `${v}pt`} />
                )}
                <Toggle on={terminal.useTrailer} onChange={(v) => setTerminal('useTrailer', v)} />
              </View>
            </Row>
            <Row label="Zone Targets" sub="TP/SL snap to nearest zones">
              <Toggle on={terminal.useZoneTargets} onChange={(v) => setTerminal('useZoneTargets', v)} />
            </Row>
            <Row label="Side-Entry Longs" sub="every vector side entry → Long" last>
              <Toggle on={terminal.takeSideEntries} onChange={(v) => setTerminal('takeSideEntries', v)} />
            </Row>
          </Card>

          {/* ── SIGNAL ENGINE ─────────────────────────────────────────────────── */}
          <Card title="Signal Engine" icon={<MarketIcon size={14} color={Trading.accent} />}>
            <Row label="Fire on Closed Candles Only">
              <Toggle on={terminal.closedOnly} onChange={(v) => setTerminal('closedOnly', v)} />
            </Row>
            <Row label="Required Confirmations" sub="Strategies to align" last>
              <Seg value={String(terminal.confirms) as '1' | '2' | '3' | '4'}
                options={['1', '2', '3', '4'] as const}
                onChange={(v) => setTerminal('confirms', parseInt(v, 10))} />
            </Row>
          </Card>

          {/* ── MACHINE LEARNING ──────────────────────────────────────────────── */}
          <Card title="Machine Learning" icon={<LayersIcon size={14} color={Trading.accent} />}>
            <Row label="Feedback Loop" sub="learn from closed trades">
              <Toggle on={terminal.mlLoop} onChange={(v) => setTerminal('mlLoop', v)} />
            </Row>
            <Row label="Retrain Frequency" last>
              <Seg value={terminal.retrain} options={['DAILY', 'WEEKLY', 'MANUAL'] as const}
                labels={{ DAILY: 'Daily', WEEKLY: 'Weekly', MANUAL: 'Manual' }}
                onChange={(v) => setTerminal('retrain', v)} />
            </Row>
          </Card>

          {/* ── AUTOTRADER (inlined — mirrors the PC) ─────────────────────────── */}
          <AutoTraderInline apiBaseUrl={apiBaseUrl} />

          {/* ── DISCORD BOT ───────────────────────────────────────────────────── */}
          <Card title="Discord Bot" icon={<SignalIcon size={14} color={Trading.accent} />}>
            <Text style={s.fieldLabel}>WEBHOOK URL</Text>
            <TextInput
              style={s.input}
              value={discordWebhook}
              onChangeText={setDiscordWebhook}
              placeholder="https://discord.com/api/webhooks/…"
              placeholderTextColor={Trading.dim}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done"
              onSubmitEditing={saveDiscord}
            />
            <Pressable style={[s.saveBtn, discordState === 'saved' && { backgroundColor: Trading.long }]} onPress={saveDiscord}>
              <Text style={s.saveTxt}>{discordState === 'saving' ? 'Linking…' : discordState === 'saved' ? '✓ Linked' : 'Link Bot'}</Text>
            </Pressable>
            <Text style={s.hint}>Signals are relayed straight to your channel when they fire.</Text>
          </Card>

          {/* ── NOTIFICATIONS (iPhone) ────────────────────────────────────────── */}
          <Card title="Notifications" icon={<SettingsIcon size={14} color={Trading.accent} />}>
            <Row label="Push to iPhone" last>
              <Toggle on={notificationsEnabled} onChange={setNotificationsEnabled} />
            </Row>
          </Card>

          {/* ── DATA FEED (iPhone endpoint) ───────────────────────────────────── */}
          <Card title="Data Feed" icon={<LayersIcon size={14} color={Trading.accent} />}>
            <Text style={s.fieldLabel}>ENDPOINT</Text>
            <TextInput
              style={s.input}
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="https://trading.jacksonlems.com"
              placeholderTextColor={Trading.dim}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done"
              onSubmitEditing={saveUrl}
            />
            <Pressable style={s.saveBtn} onPress={saveUrl}><Text style={s.saveTxt}>Save Endpoint</Text></Pressable>
            <View style={[s.conn, { marginTop: 11 }]}>
              <View style={[s.dot, { backgroundColor: connected ? Trading.long : Trading.short }]} />
              <Text style={[s.connTxt, { color: connected ? Trading.long : Trading.muted }]}>
                {connected ? 'CONNECTED' : 'NOT CONNECTED'}
              </Text>
            </View>
          </Card>

          <Pressable style={s.welcome} onPress={() => router.replace('/')}>
            <Text style={s.welcomeTxt}>← Back to Welcome</Text>
          </Pressable>
          <View style={{ height: 20 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  titleBar: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 8 },
  title: { fontFamily: Fonts.bold, fontSize: 18, fontWeight: '700', letterSpacing: 2, color: Trading.text },
  scroll: { paddingHorizontal: 16, paddingBottom: 24, gap: 13 },

  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  conn: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  connTxt: { fontFamily: Fonts.mono, fontSize: 10, letterSpacing: 1, fontWeight: '600' },

  armBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6 },
  armState: { fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  armSub: { fontSize: 11, fontWeight: '600' },
  armBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  armBtnTxt: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  warn: { color: '#ef5350', fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textAlign: 'center', marginTop: 10 },

  fieldLabel: { fontFamily: Fonts.display, fontSize: 9, letterSpacing: 1, color: Trading.muted, fontWeight: '600', marginTop: 6, marginBottom: 6 },
  input: { backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8, borderWidth: 1, borderColor: Trading.line, color: Trading.accent, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.mono },
  saveBtn: { marginTop: 8, backgroundColor: Trading.accent, borderRadius: 9, paddingVertical: 12, alignItems: 'center' },
  saveTxt: { color: '#04140f', fontSize: 13, fontWeight: '700', letterSpacing: 0.5, fontFamily: Fonts.display },
  hint: { color: Trading.dim, fontSize: 11, marginTop: 8, lineHeight: 15 },

  welcome: { marginTop: 8, paddingVertical: 12, alignItems: 'center' },
  welcomeTxt: { color: Trading.muted, fontSize: 13, fontWeight: '600' },
});
