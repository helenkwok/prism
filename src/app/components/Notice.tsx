// 07-UI-SPEC "Notice variants": one component for fixture, info, refused,
// stopped and error notices. A refusal is an expected outcome, so it is ink,
// never red; only `error` (form validation, sign-in failure) uses --destructive.
import type { ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";

export type NoticeVariant = "fixture" | "info" | "refused" | "stopped" | "error";

const VARIANTS: Record<NoticeVariant, { surface: string; icon: string | null; role?: "alert" | "status" }> = {
  fixture: { surface: "bg-muted border-foreground", icon: null },
  info: { surface: "bg-muted border-border", icon: "icon-[lucide--info]" },
  refused: { surface: "bg-card border-foreground", icon: "icon-[lucide--ban]" },
  stopped: { surface: "bg-card border-foreground", icon: "icon-[lucide--ban]", role: "status" },
  error: { surface: "bg-card border-destructive text-destructive", icon: "icon-[lucide--circle-alert]", role: "alert" },
};

export const FIXTURE_NOTICE = "Synthetic test data. These records are invented to test the app and are not findings.";

export function Notice({
  variant,
  children,
  announce,
  className,
  id,
  ref,
}: {
  variant: NoticeVariant;
  children: ReactNode;
  /** refused: role="alert" when shown after a submit. */
  announce?: boolean;
  className?: string;
  id?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const v = VARIANTS[variant];
  const role = variant === "refused" ? (announce ? "alert" : undefined) : v.role;
  return (
    <div
      id={id}
      ref={ref}
      role={role}
      tabIndex={role === "alert" ? -1 : undefined}
      data-notice={variant}
      className={cn("flex items-start gap-2 rounded-lg border p-4 text-base", v.surface, className)}
    >
      {v.icon ? <span className={cn(v.icon, "mt-1 size-4 shrink-0")} aria-hidden="true" /> : null}
      <div>{children}</div>
    </div>
  );
}
