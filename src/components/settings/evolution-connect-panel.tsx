'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, QrCode, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

// Same polling cadence/ref-guard pattern as
// src/app/(dashboard)/broadcasts/page.tsx's POLL_INTERVAL_MS —
// reused here rather than inventing a second polling convention.
const POLL_INTERVAL_MS = 3_000;

type ConnectState = 'idle' | 'creating' | 'awaiting_scan' | 'connected' | 'error';

interface EvolutionConnectPanelProps {
  /** True when the saved whatsapp_config row is already on 'evolution'
   *  (vs. the user just picked this option in the selector without
   *  having connected anything yet). */
  isCurrentProvider: boolean;
  initialStatus?: 'connected' | 'disconnected';
}

export function EvolutionConnectPanel({
  isCurrentProvider,
  initialStatus,
}: EvolutionConnectPanelProps) {
  const [state, setState] = useState<ConnectState>(
    isCurrentProvider && initialStatus === 'connected' ? 'connected' : 'idle',
  );
  const [qrCodeBase64, setQrCodeBase64] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (!pollTimer.current) return;
    clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/evolution/status');
      const payload = await res.json();
      if (payload.connected) {
        stopPolling();
        setState('connected');
        toast.success('WhatsApp conectado!');
      }
    } catch (err) {
      console.error('Evolution status poll failed:', err);
    }
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    pollTimer.current = setInterval(pollStatus, POLL_INTERVAL_MS);
  }, [pollStatus]);

  // Stop polling on unmount so a closed/navigated-away panel doesn't
  // keep hitting the status endpoint.
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  async function handleConnect() {
    setState('creating');
    setErrorMessage('');
    try {
      const res = await fetch('/api/whatsapp/evolution/connect', { method: 'POST' });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      setQrCodeBase64(payload.qrCodeBase64);
      setState('awaiting_scan');
      startPolling();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao conectar';
      setErrorMessage(message);
      setState('error');
      toast.error(message);
    }
  }

  return (
    <div className="max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Conexão via WhatsApp Web</CardTitle>
          <CardDescription className="text-muted-foreground">
            Escaneie o QR code com o WhatsApp do celular (Aparelhos conectados). Sem aprovação da
            Meta, sem número comercial verificado — só texto por enquanto.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === 'idle' && (
            <Button
              onClick={handleConnect}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <QrCode className="size-4" />
              Conectar
            </Button>
          )}

          {state === 'creating' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Criando conexão…
            </div>
          )}

          {state === 'awaiting_scan' && qrCodeBase64 && (
            <div className="flex flex-col items-center gap-3">
              <img
                src={qrCodeBase64}
                alt="QR code para conectar o WhatsApp"
                className="size-56 rounded-md border border-border"
              />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Aguardando leitura do QR code…
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnect}
                className="border-border"
              >
                <RefreshCw className="size-3.5" />
                Gerar novo QR code
              </Button>
            </div>
          )}

          {state === 'connected' && (
            <Alert className="bg-emerald-950/30 border-emerald-700/50">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-400" />
                <AlertTitle className="mb-0 text-emerald-200">Conectado</AlertTitle>
              </div>
              <AlertDescription className="text-muted-foreground">
                O WhatsApp está conectado via WhatsApp Web. Se desconectar (celular sem internet,
                sessão encerrada no aparelho), gere um novo QR code aqui.
              </AlertDescription>
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnect}
                className="mt-3 border-border"
              >
                <RefreshCw className="size-3.5" />
                Reconectar
              </Button>
            </Alert>
          )}

          {state === 'error' && (
            <div className="space-y-3">
              <Alert className="bg-red-950/30 border-red-700/50">
                <AlertTitle className="text-red-200">Falha ao conectar</AlertTitle>
                <AlertDescription className="text-muted-foreground">
                  {errorMessage}
                </AlertDescription>
              </Alert>
              <Button
                variant="outline"
                onClick={handleConnect}
                className="border-border"
              >
                Tentar novamente
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
