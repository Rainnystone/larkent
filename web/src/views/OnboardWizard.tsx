import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { AgentKind, OnboardAgentChoice, OnboardState } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";

type Phase = "loading" | "waiting" | "confirm" | "creating" | "error";

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function OnboardWizard({ onCreated }: { onCreated: (profile: string) => void }) {
  const [agentKind, setAgentKind] = useState<AgentKind | "">("");
  const [agentKinds, setAgentKinds] = useState<OnboardAgentChoice[]>([]);
  const [profileName, setProfileName] = useState("");
  const [botName, setBotName] = useState("");
  const [detected, setDetected] = useState<AgentKind[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [qr, setQr] = useState<{ sessionId: string; qrUrl: string; expireIn: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanned = useRef(false);

  useEffect(() => {
    apiGet<OnboardState>("/api/onboard/state")
      .then((s) => {
        setDetected(s.detectedAgents);
        setExisting(s.profiles);
        setAgentKinds(s.agentKinds);
        setAgentKind("");
      })
      .catch(() => {});
  }, []);

  const selected = agentKinds.find((choice) => choice.kind === agentKind);
  const missingRequired = Boolean(
    selected?.requireInstalled && agentKind && !detected.includes(agentKind),
  );

  const stopPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  async function generate() {
    stopPolling();
    scanned.current = false;
    setQr(null);
    setPhase("loading");
    try {
      const r = await apiPost<{ sessionId: string; qrUrl: string; expireIn: number }>(
        "/api/profiles/qr/start",
        {},
      );
      setQr(r);
      setPhase("waiting");
      timer.current = setInterval(() => void poll(r.sessionId), 2000);
    } catch (e) {
      setPhase("error");
      toast.error(String((e as Error).message ?? e));
    }
  }

  async function poll(sessionId: string) {
    let s: { status: string; error?: string; botName?: string; suggestedProfile?: string };
    try {
      s = await apiGet(`/api/profiles/qr/status?sessionId=${encodeURIComponent(sessionId)}`);
    } catch {
      return;
    }
    if (s.status === "scanned" && !scanned.current) {
      scanned.current = true;
      stopPolling();
      setBotName(s.botName ?? "");
      setProfileName(s.suggestedProfile || uniqueName(agentKind || "bot", existing));
      setPhase("confirm");
    } else if (s.status === "error") {
      stopPolling();
      setPhase("error");
      toast.error(s.error ?? "扫码创建失败");
    }
  }

  async function confirmCreate() {
    if (!qr || !agentKind) return;
    if (missingRequired) {
      toast.error(selected?.displayName
        ? `未检测到 ${selected.displayName}。请先安装并登录后再创建 ${agentKind} profile。`
        : "请先安装所选 agent 后再创建 profile。");
      return;
    }
    setPhase("creating");
    try {
      const r = await apiPost<{ profile: string }>("/api/profiles/qr/finish", {
        sessionId: qr.sessionId,
        agentKind,
        profile: profileName.trim(),
      });
      toast.success(`profile「${r.profile}」已创建`);
      onCreated(r.profile);
    } catch (e) {
      setPhase("confirm");
      toast.error(String((e as Error).message ?? e));
    }
  }

  useEffect(() => {
    void generate();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "confirm" || phase === "creating") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="size-4" /> 应用已创建{botName ? `：${botName}` : ""}，确认后完成
        </div>
        <div className="space-y-1.5">
          <Label>AI Agent</Label>
          <Select
            value={agentKind || undefined}
            onValueChange={(v) => setAgentKind(v as AgentKind)}
          >
            <SelectTrigger><SelectValue placeholder="选择 agent" /></SelectTrigger>
            <SelectContent>
              {agentKinds.map((choice) => (
                <SelectItem key={choice.kind} value={choice.kind}>
                  {choice.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Profile 名称</Label>
          <Input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder={agentKind || "profile"}
          />
          {existing.includes(profileName.trim()) && (
            <p className="text-xs text-destructive">已存在同名 profile，请换个名字（不会覆盖现有的）。</p>
          )}
          {missingRequired && (
            <p className="text-xs text-destructive">
              未检测到 {selected?.displayName}。请先安装并登录。
            </p>
          )}
        </div>
        <div className="flex justify-end">
          <Button
            onClick={confirmCreate}
            disabled={
              phase === "creating" ||
              !agentKind ||
              !profileName.trim() ||
              existing.includes(profileName.trim()) ||
              missingRequired
            }
          >
            {phase === "creating" ? "创建中…" : "确定创建"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-2">
        <div className="flex size-[232px] items-center justify-center rounded-lg border bg-white p-4">
          {qr ? (
            <QRCodeSVG value={qr.qrUrl} size={200} />
          ) : (
            <span className="text-sm text-muted-foreground">
              {phase === "error" ? "二维码生成失败" : "生成二维码中…"}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {phase === "error" ? "请重试" : "用飞书 App 扫码创建新应用，扫完再填 Profile 名称"}
        </p>
        {qr && (
          <p className="text-xs text-muted-foreground">
            有效期约 {Math.max(1, Math.round(qr.expireIn / 60))} 分钟 ·{" "}
            <a href={qr.qrUrl} target="_blank" rel="noreferrer" className="text-primary underline">在浏览器打开</a>
          </p>
        )}
        {(phase === "error" || phase === "waiting") && (
          <Button variant="outline" size="sm" onClick={generate}>重新生成</Button>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground">扫码人会成为应用 owner，自动豁免访问控制。</p>
    </div>
  );
}
