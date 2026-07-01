import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Modal,
  TextInput, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useApp } from '@/context/app-context';
import { Trading, Fonts } from '@/constants/theme';

type Outcome      = 'win_tp1' | 'win_tp2' | 'loss' | 'breakeven' | '';
type RiskLevel    = 'safe' | 'risky' | 'riskiest';
type EmotionState = 'calm' | 'fomo' | 'fear' | 'revenge' | 'other';
type SetupType    = 'side_entry' | 'tabletop' | 'confluence' | 'pattern' | 'other' | '';

interface JournalEntry {
  id: number;
  timestamp: number;
  symbol: string;
  direction: string;
  signal_id: number | null;
  entry_price: number;
  exit_price: number | null;
  outcome: string | null;
  pnl_pts: number | null;
  pnl_dollars: number | null;
  risk_level: string;
  followed_plan: number;
  emotion_state: string;
  setup_type: string | null;
  notes: string | null;
  error_made: string | null;
}

interface JournalStats {
  total: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlDollars: number;
  byEmotion: Record<string, { count: number; wins: number; losses: number }>;
  byPlan: Record<string, { count: number; wins: number }>;
}

const OUTCOME_LABEL: Record<string, string> = {
  win_tp1: 'TP1 Win', win_tp2: 'TP2 Win', loss: 'Loss', breakeven: 'Breakeven',
};
const OUTCOME_COLOR: Record<string, string> = {
  win_tp1: '#22c55e', win_tp2: '#16a34a', loss: '#ef4444', breakeven: '#94a3b8',
};
const EMOTION_LABEL: Record<string, string> = {
  calm: 'Calm', fomo: 'FOMO', fear: 'Fear', revenge: 'Revenge', other: 'Other',
};

function pnlColor(v: number | null): string {
  if (v == null || v === 0) return Trading.muted;
  return v > 0 ? Trading.long : Trading.short;
}
function fmtPnl(v: number | null): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}
function calcPnl(entry: number, exit: number | null, dir: string) {
  if (exit == null) return { pts: null, dollars: null };
  const pts = dir === 'Long' ? exit - entry : entry - exit;
  return { pts, dollars: pts * 5 };
}
function riskColor(rl: string): string {
  const map: Record<string, string> = { safe: Trading.safe, risky: Trading.risky, riskiest: Trading.riskiest };
  return map[rl] ?? Trading.muted;
}
function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
}
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York',
  });
}

const EMPTY_FORM = {
  symbol: 'MES', direction: 'Long' as 'Long' | 'Short',
  entryPrice: '', exitPrice: '', outcome: '' as Outcome,
  riskLevel: 'safe' as RiskLevel, followedPlan: true,
  emotionState: 'calm' as EmotionState, setupType: '' as SetupType,
  notes: '', errorMade: '',
};

export default function JournalScreen() {
  const { apiBaseUrl } = useApp();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [stats,   setStats]   = useState<JournalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editId,   setEditId]   = useState<number | null>(null);
  const [form,     setForm]     = useState({ ...EMPTY_FORM });

  // Detail modal
  const [selected, setSelected] = useState<JournalEntry | null>(null);

  const load = useCallback(async () => {
    try {
      const [eRes, sRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/journal`),
        fetch(`${apiBaseUrl}/api/journal/stats`),
      ]);
      if (eRes.ok) setEntries(await eRes.json());
      if (sRes.ok) setStats(await sRes.json());
    } catch {}
    setLoading(false);
  }, [apiBaseUrl]);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => { setForm({ ...EMPTY_FORM }); setEditId(null); };

  const openAdd = () => { resetForm(); setShowForm(true); };
  const openEdit = (e: JournalEntry) => {
    setForm({
      symbol: e.symbol, direction: e.direction as 'Long' | 'Short',
      entryPrice: String(e.entry_price),
      exitPrice: e.exit_price != null ? String(e.exit_price) : '',
      outcome: (e.outcome ?? '') as Outcome,
      riskLevel: (e.risk_level ?? 'safe') as RiskLevel,
      followedPlan: !!e.followed_plan,
      emotionState: (e.emotion_state ?? 'calm') as EmotionState,
      setupType: (e.setup_type ?? '') as SetupType,
      notes: e.notes ?? '', errorMade: e.error_made ?? '',
    });
    setEditId(e.id);
    setShowForm(true);
  };

  const save = async () => {
    if (!form.entryPrice) { Alert.alert('Entry price required'); return; }
    setSaving(true);
    const ep = parseFloat(form.entryPrice);
    const xp = form.exitPrice ? parseFloat(form.exitPrice) : null;
    const { pts, dollars } = calcPnl(ep, xp, form.direction);
    const body = {
      timestamp: Math.floor(Date.now() / 1000),
      symbol: form.symbol, direction: form.direction,
      entryPrice: ep, exitPrice: xp,
      outcome: form.outcome || null,
      pnlPts: pts, pnlDollars: dollars,
      riskLevel: form.riskLevel, followedPlan: form.followedPlan,
      emotionState: form.emotionState, setupType: form.setupType || null,
      notes: form.notes || null, errorMade: form.errorMade || null,
    };
    try {
      if (editId != null) {
        await fetch(`${apiBaseUrl}/api/journal/${editId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        await fetch(`${apiBaseUrl}/api/journal`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      resetForm();
      setShowForm(false);
      load();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) { Alert.alert('Error saving', String(e)); }
    setSaving(false);
  };

  const deleteEntry = (id: number) => {
    Alert.alert('Delete entry?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await fetch(`${apiBaseUrl}/api/journal/${id}`, { method: 'DELETE' }).catch(() => {});
        setSelected(null);
        load();
      }},
    ]);
  };

  const autoPnl = (() => {
    if (!form.entryPrice || !form.exitPrice) return null;
    const { pts } = calcPnl(parseFloat(form.entryPrice), parseFloat(form.exitPrice), form.direction);
    return pts;
  })();

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* ── App bar ──────────────────────────────────────────────────────────── */}
      <View style={s.appBar}>
        <Text style={s.appBarTitle}>TRADE JOURNAL</Text>
        <Pressable style={s.addBtn} onPress={openAdd}>
          <Text style={s.addBtnTxt}>+ Log Trade</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Stats ──────────────────────────────────────────────────────────── */}
        {stats && (
          <Animated.View entering={FadeIn.duration(300)} style={s.statGrid}>
            <StatCell label="TOTAL"    value={String(stats.total)} />
            <StatCell label="WIN RATE" value={stats.closed ? `${Math.round(stats.winRate)}%` : '—'}
              color={stats.winRate >= 50 ? Trading.long : Trading.short} />
            <StatCell label="NET $"    value={`${stats.totalPnlDollars >= 0 ? '+' : ''}$${Math.abs(stats.totalPnlDollars).toFixed(0)}`}
              color={pnlColor(stats.totalPnlDollars)} />
            <StatCell label="CLOSED"  value={String(stats.closed)} />
          </Animated.View>
        )}

        {/* ── Entry list ─────────────────────────────────────────────────────── */}
        {loading ? (
          <View style={s.empty}><ActivityIndicator color={Trading.accent} /></View>
        ) : entries.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTxt}>No journal entries yet</Text>
            <Text style={s.emptySub}>Tap "+ Log Trade" to record your first trade</Text>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            {entries.map((e, i) => {
              const long = e.direction === 'Long';
              const oc   = e.outcome ? OUTCOME_COLOR[e.outcome] : Trading.amber;
              const ocLabel = e.outcome ? OUTCOME_LABEL[e.outcome] : 'Open';
              return (
                <Animated.View key={e.id} entering={FadeInDown.duration(360).delay(Math.min(i, 15) * 35)}>
                  <Pressable style={s.card} onPress={() => { Haptics.selectionAsync().catch(() => {}); setSelected(e); }}>
                    <View style={s.cardTop}>
                      <View style={s.cardId}>
                        <Text style={[s.dir, { color: long ? Trading.long : Trading.short, backgroundColor: (long ? Trading.long : Trading.short) + '1a' }]}>
                          {e.direction.toUpperCase()}
                        </Text>
                        <Text style={s.sym}>{e.symbol}</Text>
                        <View style={[s.tier, { borderColor: riskColor(e.risk_level) + '80' }]}>
                          <Text style={[s.tierTxt, { color: riskColor(e.risk_level) }]}>
                            {e.risk_level.toUpperCase()}
                          </Text>
                        </View>
                      </View>
                      <Text style={s.dateTime}>{fmtDate(e.timestamp)} · {fmtTime(e.timestamp)}</Text>
                    </View>

                    <View style={s.priceRow}>
                      <PriceCell label="ENTRY" value={e.entry_price.toFixed(2)} />
                      <PriceCell label="EXIT"  value={e.exit_price != null ? e.exit_price.toFixed(2) : '—'} />
                      <PriceCell label="PNL PTS" value={fmtPnl(e.pnl_pts)} color={pnlColor(e.pnl_pts)} />
                      <PriceCell label="PNL $"   value={e.pnl_dollars != null ? `$${e.pnl_dollars.toFixed(0)}` : '—'} color={pnlColor(e.pnl_dollars)} />
                    </View>

                    <View style={s.foot}>
                      <View style={[s.outcomeChip, { backgroundColor: oc + '1a', borderColor: oc + '50' }]}>
                        {!e.outcome && <View style={[s.dot, { backgroundColor: Trading.amber }]} />}
                        <Text style={[s.outcomeTxt, { color: oc }]}>{ocLabel}</Text>
                      </View>
                      <Text style={s.emo}>{EMOTION_LABEL[e.emotion_state] ?? e.emotion_state}</Text>
                    </View>
                  </Pressable>
                </Animated.View>
              );
            })}
          </View>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* ── Add / Edit form modal ─────────────────────────────────────────────── */}
      <Modal visible={showForm} animationType="slide" onRequestClose={() => { setShowForm(false); resetForm(); }}>
        <SafeAreaView style={s.formSafe} edges={['top', 'bottom']}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={s.formBar}>
              <Text style={s.formTitle}>{editId != null ? 'Edit Entry' : 'Log a Trade'}</Text>
              <Pressable onPress={() => { setShowForm(false); resetForm(); }} hitSlop={12}>
                <Text style={s.formClose}>✕</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={s.formScroll} keyboardShouldPersistTaps="handled">

              {/* Symbol + Direction */}
              <FormSection label="SYMBOL">
                <TextInput style={s.input} value={form.symbol}
                  onChangeText={v => setForm(f => ({ ...f, symbol: v.toUpperCase() }))}
                  placeholder="MES" placeholderTextColor={Trading.dim}
                  autoCapitalize="characters" returnKeyType="done" />
              </FormSection>

              <FormSection label="DIRECTION">
                <View style={s.toggleRow}>
                  {(['Long', 'Short'] as const).map(d => (
                    <Pressable key={d} onPress={() => setForm(f => ({ ...f, direction: d }))}
                      style={[s.toggleBtn, form.direction === d && { borderColor: d === 'Long' ? Trading.long : Trading.short, backgroundColor: (d === 'Long' ? Trading.long : Trading.short) + '20' }]}>
                      <Text style={[s.toggleTxt, form.direction === d && { color: d === 'Long' ? Trading.long : Trading.short }]}>
                        {d === 'Long' ? '▲ Long' : '▼ Short'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </FormSection>

              {/* Prices */}
              <View style={s.priceInputRow}>
                <View style={{ flex: 1 }}>
                  <FormSection label="ENTRY PRICE">
                    <TextInput style={s.input} value={form.entryPrice}
                      onChangeText={v => setForm(f => ({ ...f, entryPrice: v }))}
                      placeholder="5842.25" placeholderTextColor={Trading.dim}
                      keyboardType="decimal-pad" returnKeyType="done" />
                  </FormSection>
                </View>
                <View style={{ flex: 1 }}>
                  <FormSection label="EXIT PRICE">
                    <TextInput style={s.input} value={form.exitPrice}
                      onChangeText={v => setForm(f => ({ ...f, exitPrice: v }))}
                      placeholder="open" placeholderTextColor={Trading.dim}
                      keyboardType="decimal-pad" returnKeyType="done" />
                  </FormSection>
                </View>
              </View>

              {autoPnl != null && (
                <Text style={[s.autoPnl, { color: pnlColor(autoPnl) }]}>
                  Auto P&L: {fmtPnl(autoPnl)} pts / ${Math.abs(autoPnl * 5).toFixed(0)} USD
                </Text>
              )}

              {/* Outcome */}
              <FormSection label="OUTCOME">
                <View style={s.toggleRow}>
                  {[['', 'Open'], ['win_tp1', 'TP1 Win'], ['win_tp2', 'TP2 Win'], ['loss', 'Loss'], ['breakeven', 'BE']]
                    .map(([v, label]) => {
                      const on = form.outcome === v;
                      const col = v ? (OUTCOME_COLOR[v] ?? Trading.accent) : Trading.amber;
                      return (
                        <Pressable key={v} onPress={() => setForm(f => ({ ...f, outcome: v as Outcome }))}
                          style={[s.toggleBtnSm, on && { borderColor: col, backgroundColor: col + '20' }]}>
                          <Text style={[s.toggleTxtSm, on && { color: col }]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                </View>
              </FormSection>

              {/* Risk level */}
              <FormSection label="RISK LEVEL">
                <View style={s.toggleRow}>
                  {(['safe', 'risky', 'riskiest'] as RiskLevel[]).map(r => {
                    const on = form.riskLevel === r;
                    const col = riskColor(r);
                    return (
                      <Pressable key={r} onPress={() => setForm(f => ({ ...f, riskLevel: r }))}
                        style={[s.toggleBtn, on && { borderColor: col, backgroundColor: col + '20' }]}>
                        <Text style={[s.toggleTxt, on && { color: col }]}>{r.toUpperCase()}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </FormSection>

              {/* Followed plan */}
              <FormSection label="FOLLOWED PLAN?">
                <View style={s.toggleRow}>
                  {([true, false] as const).map(v => {
                    const on = form.followedPlan === v;
                    const col = v ? Trading.long : Trading.short;
                    return (
                      <Pressable key={String(v)} onPress={() => setForm(f => ({ ...f, followedPlan: v }))}
                        style={[s.toggleBtn, on && { borderColor: col, backgroundColor: col + '20' }]}>
                        <Text style={[s.toggleTxt, on && { color: col }]}>{v ? 'Yes' : 'No'}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </FormSection>

              {/* Emotion */}
              <FormSection label="EMOTION STATE">
                <View style={s.toggleRow}>
                  {(['calm', 'fomo', 'fear', 'revenge', 'other'] as EmotionState[]).map(e => {
                    const on = form.emotionState === e;
                    return (
                      <Pressable key={e} onPress={() => setForm(f => ({ ...f, emotionState: e }))}
                        style={[s.toggleBtnSm, on && { borderColor: Trading.accent, backgroundColor: Trading.accent + '20' }]}>
                        <Text style={[s.toggleTxtSm, on && { color: Trading.accent }]}>{EMOTION_LABEL[e]}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </FormSection>

              {/* Setup type */}
              <FormSection label="SETUP TYPE">
                <View style={s.toggleRow}>
                  {([['', 'None'], ['side_entry', 'Side Entry'], ['tabletop', 'Tabletop'],
                     ['confluence', 'Confluence'], ['pattern', 'Pattern'], ['other', 'Other']]
                    .map(([v, label]) => {
                      const on = form.setupType === v;
                      return (
                        <Pressable key={v} onPress={() => setForm(f => ({ ...f, setupType: v as SetupType }))}
                          style={[s.toggleBtnSm, on && { borderColor: Trading.accent, backgroundColor: Trading.accent + '20' }]}>
                          <Text style={[s.toggleTxtSm, on && { color: Trading.accent }]}>{label}</Text>
                        </Pressable>
                      );
                    }))}
                </View>
              </FormSection>

              {/* Notes */}
              <FormSection label="NOTES">
                <TextInput style={[s.input, s.textArea]} value={form.notes}
                  onChangeText={v => setForm(f => ({ ...f, notes: v }))}
                  placeholder="What happened, key observations…" placeholderTextColor={Trading.dim}
                  multiline numberOfLines={3} returnKeyType="default" />
              </FormSection>

              {/* Error */}
              <FormSection label="ERROR / WHAT TO IMPROVE">
                <TextInput style={[s.input, s.textArea]} value={form.errorMade}
                  onChangeText={v => setForm(f => ({ ...f, errorMade: v }))}
                  placeholder="Entered too early, chased price, ignored 60m veto…" placeholderTextColor={Trading.dim}
                  multiline numberOfLines={3} returnKeyType="default" />
              </FormSection>

              <Pressable style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving}>
                {saving ? <ActivityIndicator color={Trading.bg} /> : <Text style={s.saveBtnTxt}>{editId != null ? 'Update Entry' : 'Save Trade'}</Text>}
              </Pressable>
              <View style={{ height: 32 }} />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      {/* ── Detail modal ─────────────────────────────────────────────────────── */}
      {selected && <DetailModal entry={selected} onClose={() => setSelected(null)} onEdit={() => { openEdit(selected); setSelected(null); }} onDelete={() => deleteEntry(selected.id)} />}
    </SafeAreaView>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function PriceCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.pcLabel}>{label}</Text>
      <Text style={[s.pcValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.fSection}>
      <Text style={s.fLabel}>{label}</Text>
      {children}
    </View>
  );
}

function DetailModal({ entry, onClose, onEdit, onDelete }: {
  entry: JournalEntry; onClose: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const long = entry.direction === 'Long';
  const oc   = entry.outcome ? OUTCOME_COLOR[entry.outcome] : Trading.amber;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={dm.backdrop} onPress={onClose}>
        <Animated.View entering={FadeIn.duration(200)} style={dm.sheet} onStartShouldSetResponder={() => true}>
          <View style={dm.header}>
            <Text style={[dm.dir, { color: long ? Trading.long : Trading.short }]}>
              {long ? '▲ LONG' : '▼ SHORT'}
            </Text>
            <Text style={dm.sym}>{entry.symbol}</Text>
            <View style={{ flex: 1 }} />
            <Pressable style={dm.editBtn} onPress={onEdit}><Text style={dm.editTxt}>Edit</Text></Pressable>
            <Pressable style={dm.delBtn} onPress={onDelete}><Text style={dm.delTxt}>Delete</Text></Pressable>
            <Pressable onPress={onClose} hitSlop={12}><Text style={dm.close}>✕</Text></Pressable>
          </View>

          <Text style={dm.sub}>{fmtDate(entry.timestamp)} · {fmtTime(entry.timestamp)} ET · {(entry.risk_level ?? '').toUpperCase()}</Text>

          <View style={dm.table}>
            {[
              { label: 'Entry',  value: entry.entry_price.toFixed(2),               color: Trading.text },
              { label: 'Exit',   value: entry.exit_price?.toFixed(2) ?? 'Open',     color: Trading.text },
              { label: 'PnL pts',value: fmtPnl(entry.pnl_pts),                     color: pnlColor(entry.pnl_pts) },
              { label: 'PnL $',  value: entry.pnl_dollars != null ? `$${entry.pnl_dollars.toFixed(0)}` : '—', color: pnlColor(entry.pnl_dollars) },
            ].map((row, i, arr) => (
              <View key={row.label} style={[dm.row, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={dm.rowLabel}>{row.label}</Text>
                <Text style={[dm.rowValue, { color: row.color }]}>{row.value}</Text>
              </View>
            ))}
          </View>

          <View style={dm.metaRow}>
            <MetaBadge label={entry.outcome ? OUTCOME_LABEL[entry.outcome] : 'Open'} color={oc} />
            <MetaBadge label={EMOTION_LABEL[entry.emotion_state] ?? entry.emotion_state} color={Trading.muted} />
            <MetaBadge label={entry.followed_plan ? '✓ Plan' : '✗ Plan'} color={entry.followed_plan ? Trading.long : Trading.short} />
          </View>

          {entry.setup_type && <Text style={dm.setup}>Setup: {entry.setup_type.replace('_', ' ')}</Text>}
          {entry.notes && <Text style={dm.notesTxt}>{entry.notes}</Text>}
          {entry.error_made && (
            <View style={dm.errorBox}>
              <Text style={dm.errorLabel}>ERROR / IMPROVE</Text>
              <Text style={dm.errorTxt}>{entry.error_made}</Text>
            </View>
          )}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function MetaBadge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[dm.badge, { borderColor: color + '60', backgroundColor: color + '18' }]}>
      <Text style={[dm.badgeTxt, { color }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: 'transparent' },
  appBar:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Trading.line },
  appBarTitle: { fontFamily: Fonts.display, fontSize: 13, fontWeight: '800', letterSpacing: 2, color: Trading.text },
  addBtn:  { backgroundColor: 'rgba(45,212,191,0.12)', borderWidth: 1, borderColor: 'rgba(45,212,191,0.35)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  addBtnTxt: { color: Trading.accent, fontSize: 12, fontWeight: '700', fontFamily: Fonts.display },

  scroll: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 16, gap: 10 },

  statGrid: { flexDirection: 'row', gap: 7 },
  stat:    { flex: 1, backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8 },
  statLabel:{ fontSize: 8, letterSpacing: 1, color: Trading.muted, fontWeight: '600' },
  statValue:{ fontFamily: Fonts.mono, fontSize: 15, fontWeight: '600', color: Trading.text, marginTop: 3 },

  card:    { backgroundColor: Trading.glass, borderWidth: 1, borderColor: Trading.line, borderRadius: 12, padding: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardId:  { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dir:     { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  sym:     { fontSize: 13, fontWeight: '700', color: Trading.text, fontFamily: Fonts.display },
  tier:    { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, borderWidth: 1 },
  tierTxt: { fontSize: 8, fontWeight: '700', letterSpacing: 0.5 },
  dateTime:{ fontFamily: Fonts.mono, fontSize: 10, color: Trading.muted },

  priceRow:{ flexDirection: 'row', marginTop: 9, gap: 4 },
  pcLabel: { fontSize: 7, letterSpacing: 0.5, color: Trading.dim, fontWeight: '600' },
  pcValue: { fontFamily: Fonts.mono, fontSize: 12, fontWeight: '500', color: Trading.text, marginTop: 2 },

  foot:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 9, borderTopWidth: 1, borderTopColor: Trading.lineSoft, marginTop: 9 },
  outcomeChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  outcomeTxt:  { fontFamily: Fonts.mono, fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },
  dot:     { width: 6, height: 6, borderRadius: 3 },
  emo:     { fontSize: 10, color: Trading.muted },

  empty:   { paddingVertical: 60, alignItems: 'center', gap: 8 },
  emptyTxt:{ color: Trading.muted, fontSize: 14 },
  emptySub:{ color: Trading.dim, fontSize: 11 },

  // Form modal
  formSafe:  { flex: 1, backgroundColor: '#08090d' },
  formBar:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Trading.line },
  formTitle: { fontFamily: Fonts.display, fontSize: 15, fontWeight: '700', letterSpacing: 1, color: Trading.text },
  formClose: { color: Trading.muted, fontSize: 20 },
  formScroll:{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 4 },

  fSection:  { marginTop: 12 },
  fLabel:    { fontSize: 9, letterSpacing: 1, color: Trading.muted, fontWeight: '600', marginBottom: 6 },

  input:     { backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 8, borderWidth: 1, borderColor: Trading.line, color: Trading.text, fontSize: 14, paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.mono },
  textArea:  { minHeight: 70, paddingTop: 10 },

  toggleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  toggleBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  toggleTxt: { color: Trading.muted, fontSize: 13, fontWeight: '600' },
  toggleBtnSm: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 7, borderWidth: 1, borderColor: Trading.line, backgroundColor: Trading.glass },
  toggleTxtSm: { color: Trading.muted, fontSize: 11, fontWeight: '600' },

  priceInputRow: { flexDirection: 'row', gap: 10, marginTop: 12 },

  autoPnl: { fontSize: 12, fontFamily: Fonts.mono, fontWeight: '600', textAlign: 'center', marginTop: 4 },

  saveBtn:    { marginTop: 20, backgroundColor: Trading.accent, borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
  saveBtnTxt: { color: '#04140f', fontSize: 15, fontWeight: '800', letterSpacing: 0.5, fontFamily: Fonts.display },
});

const dm = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet:    { backgroundColor: '#0a0c12', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderColor: 'rgba(45,212,191,0.2)', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 40 },
  header:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dir:      { fontSize: 16, fontWeight: '800' },
  sym:      { fontSize: 16, fontWeight: '700', color: Trading.text, fontFamily: Fonts.display },
  close:    { color: Trading.muted, fontSize: 18 },
  editBtn:  { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: Trading.line },
  editTxt:  { color: Trading.accent, fontSize: 12, fontWeight: '600' },
  delBtn:   { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: Trading.short + '60', backgroundColor: Trading.short + '12' },
  delTxt:   { color: Trading.short, fontSize: 12, fontWeight: '600' },
  sub:      { fontSize: 11, color: Trading.muted, marginTop: 8, marginBottom: 14 },
  table:    { borderRadius: 10, borderWidth: 1, borderColor: Trading.line, overflow: 'hidden', backgroundColor: Trading.glass },
  row:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Trading.lineSoft },
  rowLabel: { fontSize: 12, color: Trading.muted, fontWeight: '600' },
  rowValue: { fontFamily: Fonts.mono, fontSize: 15, fontWeight: '700' },
  metaRow:  { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  badge:    { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7, borderWidth: 1 },
  badgeTxt: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  setup:    { fontSize: 11, color: Trading.muted, marginTop: 10 },
  notesTxt: { fontSize: 13, color: Trading.text, marginTop: 10, lineHeight: 19 },
  errorBox: { backgroundColor: Trading.short + '10', borderRadius: 8, borderWidth: 1, borderColor: Trading.short + '30', padding: 12, marginTop: 12 },
  errorLabel:{ fontSize: 9, color: Trading.short, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  errorTxt: { fontSize: 12, color: Trading.text, lineHeight: 18 },
});
