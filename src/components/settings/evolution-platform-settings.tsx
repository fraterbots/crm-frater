'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, Save, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

const MASKED_KEY = '••••••••••••••••';

/**
 * Owner-only panel for the platform-wide Evolution API server
 * credentials (one self-hosted Evolution server shared across every
 * account on the CRM — not per-account data, see
 * supabase/migrations/034_platform_settings.sql). Lets an owner fill
 * these in from Settings instead of editing Vercel env vars.
 *
 * Only rendered for accountRole === 'owner' — see whatsapp-config.tsx.
 * Not i18n'd, matching this file's neighbors (see the TODO in
 * whatsapp-config.tsx).
 */
export function EvolutionPlatformSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/platform-settings');
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const data = await res.json();
        setApiUrl(data.evolutionApiUrl || '');
        setHasSavedKey(!!data.hasEvolutionApiKey);
        setApiKey(data.hasEvolutionApiKey ? MASKED_KEY : '');
      } catch (err) {
        console.error('Failed to load platform settings:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    if (!apiUrl.trim()) {
      toast.error('URL do servidor Evolution é obrigatória');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, string> = { evolutionApiUrl: apiUrl.trim() };
      if (keyEdited && apiKey !== MASKED_KEY && apiKey.trim()) {
        payload.evolutionApiKey = apiKey.trim();
      }
      const res = await fetch('/api/platform-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao salvar');
        return;
      }
      toast.success('Configuração do servidor Evolution salva.');
      if (payload.evolutionApiKey) {
        setHasSavedKey(true);
        setApiKey(MASKED_KEY);
        setKeyEdited(false);
      }
    } catch (err) {
      console.error('Save platform settings error:', err);
      toast.error('Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Carregando configuração do servidor…
      </div>
    );
  }

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Settings2 className="size-4" />
          Servidor Evolution API
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Endereço e chave do seu servidor Evolution API (self-hosted). Visível só para
          proprietários da conta — vale para toda a plataforma, não só esta conta.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-muted-foreground">URL do servidor</Label>
          <Input
            placeholder="https://evo.exemplo.com"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-muted-foreground">Chave de API (admin)</Label>
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              placeholder="Chave de administrador do Evolution"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setKeyEdited(true);
              }}
              onFocus={() => {
                if (apiKey === MASKED_KEY) {
                  setApiKey('');
                  setKeyEdited(true);
                }
              }}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {hasSavedKey && !keyEdited && (
            <p className="text-xs text-muted-foreground">
              Chave salva e oculta. Só é reenviada se você digitar uma nova.
            </p>
          )}
        </div>
        <Button
          onClick={handleSave}
          disabled={saving}
          size="sm"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Salvar
        </Button>
      </CardContent>
    </Card>
  );
}
