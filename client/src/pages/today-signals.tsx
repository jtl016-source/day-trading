import SignalsPanel from "@/components/SignalsPanel";

const IVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600 };

export default function TodaySignalsPage() {
  return (
    <div style={{ height: "100vh", overflow: "hidden" }}>
      <SignalsPanel
        defaultSymbol="MES"
        defaultInterval="5m"
        onViewOnChart={(ts, ivSec) => {
          const ivMap: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "60m" };
          const iv = ivMap[ivSec] ?? "5m";
          window.location.href = `/?symbol=MES&interval=${iv}&time=${ts}&padding=30`;
        }}
      />
    </div>
  );
}
