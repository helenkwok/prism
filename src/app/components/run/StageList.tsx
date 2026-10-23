// 07-UI-SPEC "Live run": the ordered stage list with one status word, time and
// message per stage. The spinner turns only under motion-safe.
import { cn } from "../../../lib/utils";
import type { StageStatus, StageView } from "../../server/live-run.ts";

export const STATUS: Record<StageStatus, { icon: string; word: string; tone: string }> = {
  waiting: { icon: "icon-[lucide--circle-dashed]", word: "Waiting", tone: "text-chart-neutral" },
  running: { icon: "icon-[lucide--loader-circle] motion-safe:animate-spin", word: "Running", tone: "text-foreground" },
  done: { icon: "icon-[lucide--circle-check]", word: "Done", tone: "text-chart-blue" },
  skipped: { icon: "icon-[lucide--circle-dot]", word: "Skipped", tone: "text-chart-neutral" },
  stopped: { icon: "icon-[lucide--ban]", word: "Stopped", tone: "text-foreground" },
  refused: { icon: "icon-[lucide--ban]", word: "Refused", tone: "text-foreground" },
  error: { icon: "icon-[lucide--ban]", word: "Error", tone: "text-foreground" },
  interrupted: { icon: "icon-[lucide--ban]", word: "Interrupted", tone: "text-foreground" },
};

/** Times are shown in UTC so the server render and the browser agree. */
export const clock = (iso: string | null) => (iso ? `${iso.slice(11, 19)} UTC` : "");

export function StageList({ stages }: { stages: StageView[] }) {
  return (
    <ol className="mt-8 border-t border-border" data-stage-list="">
      {stages.map((s) => {
        const st = STATUS[s.status];
        return (
          <li key={s.stage} data-stage={s.stage} data-status={s.status} className="flex min-h-12 items-start gap-3 border-b border-border py-3">
            <span className={cn(st.icon, st.tone, "mt-1 size-4 shrink-0")} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-base font-semibold">{s.label}</span>
                <span className="text-[0.8125rem]" data-stage-status="">
                  {st.word}
                </span>
                <span className="text-[0.8125rem] tabular-nums text-muted-foreground">{clock(s.at)}</span>
              </div>
              {s.message ? <p className="text-[0.8125rem] text-muted-foreground">{s.message}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
