'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Copy, Loader2, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/use-translation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  subscribed_events: string[];
  is_active: boolean;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  event: string;
  response_status: number | null;
  error: string | null;
  created_at: string;
}

const EVENTS = [
  'message.received',
  'message.sent',
  'conversation.created',
  'conversation.assigned',
  'conversation.closed',
  'contact.created',
] as const;

/**
 * CRUD manager for `outbound_webhooks` (migration 042) — all writes go
 * through /api/webhooks/* rather than the Supabase client directly,
 * since the signing secret has to be encrypted server-side
 * (src/lib/whatsapp/encryption.ts's key never reaches the browser).
 * The secret is shown exactly once, right after creation, same
 * contract as the API keys panel.
 */
export function WebhooksManager() {
  const { t } = useTranslation();

  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/webhooks');
    if (res.ok) {
      const json = await res.json();
      setWebhooks(json.webhooks ?? []);
    } else {
      toast.error(t('settings.webhooks.errorLoad'));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  function openCreate() {
    setName('');
    setUrl('');
    setEvents(new Set());
    setRevealedSecret(null);
    setCreateOpen(true);
  }

  function toggleEvent(event: string) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  }

  async function handleCreate() {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, subscribed_events: [...events] }),
    });
    setSaving(false);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error || t('settings.webhooks.errorSave'));
      return;
    }
    setRevealedSecret(json.secret);
    await fetchAll();
  }

  async function toggleActive(webhook: WebhookRow) {
    setBusyId(webhook.id);
    const res = await fetch(`/api/webhooks/${webhook.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !webhook.is_active }),
    });
    setBusyId(null);
    if (!res.ok) {
      toast.error(t('settings.webhooks.errorSave'));
      return;
    }
    await fetchAll();
  }

  async function handleDelete(webhook: WebhookRow) {
    if (!window.confirm(t('settings.webhooks.confirmDelete', { name: webhook.name }))) return;
    setBusyId(webhook.id);
    const res = await fetch(`/api/webhooks/${webhook.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (!res.ok) {
      toast.error(t('settings.webhooks.errorDelete'));
      return;
    }
    toast.success(t('settings.webhooks.deleted', { name: webhook.name }));
    await fetchAll();
  }

  async function toggleExpand(webhook: WebhookRow) {
    if (expandedId === webhook.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(webhook.id);
    const res = await fetch(`/api/webhooks/${webhook.id}/deliveries`);
    if (res.ok) {
      const json = await res.json();
      setDeliveries(json.deliveries ?? []);
    } else {
      setDeliveries([]);
    }
  }

  function copySecret() {
    if (!revealedSecret) return;
    navigator.clipboard.writeText(revealedSecret);
    toast.success(t('settings.webhooks.secretCopied'));
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.webhooks.title')}
        description={t('settings.webhooks.description')}
        action={
          <Button onClick={openCreate} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="size-4" />
            {t('settings.webhooks.add')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.webhooks.loading')}
        </div>
      ) : webhooks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.webhooks.noWebhooksYet')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {webhooks.map((webhook) => (
            <Card key={webhook.id}>
              <CardContent>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <WebhookIcon className="size-4 text-muted-foreground" />
                      <span className="font-medium text-foreground">{webhook.name}</span>
                      {!webhook.is_active && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t('settings.webhooks.inactiveBadge')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">{webhook.url}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {webhook.subscribed_events.length > 0
                        ? webhook.subscribed_events.join(', ')
                        : t('settings.webhooks.noEvents')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === webhook.id}
                      onClick={() => toggleActive(webhook)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {webhook.is_active
                        ? t('settings.webhooks.deactivate')
                        : t('settings.webhooks.activate')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => toggleExpand(webhook)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ChevronDown
                        className={`size-4 transition-transform ${expandedId === webhook.id ? 'rotate-180' : ''}`}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyId === webhook.id}
                      onClick={() => handleDelete(webhook)}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      {busyId === webhook.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {expandedId === webhook.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    {deliveries.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t('settings.webhooks.noDeliveries')}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {deliveries.map((d) => (
                          <div key={d.id} className="flex items-center gap-2 text-xs">
                            <span
                              className={
                                d.error ? 'text-red-400' : 'text-emerald-400'
                              }
                            >
                              {d.error ? '✕' : '✓'}
                            </span>
                            <span className="text-muted-foreground">{d.event}</span>
                            <span className="text-muted-foreground">
                              {d.response_status ?? '—'}
                            </span>
                            <span className="text-muted-foreground">
                              {new Date(d.created_at).toLocaleString()}
                            </span>
                            {d.error && <span className="truncate text-red-400">{d.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          {revealedSecret ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {t('settings.webhooks.secretRevealTitle')}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t('settings.webhooks.secretRevealDescription')}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-2">
                <code className="flex-1 overflow-x-auto text-xs text-foreground">{revealedSecret}</code>
                <Button variant="ghost" size="icon-sm" onClick={copySecret}>
                  <Copy className="size-4" />
                </Button>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => setCreateOpen(false)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="size-4" />
                  {t('settings.webhooks.done')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {t('settings.webhooks.newDialogTitle')}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t('settings.webhooks.dialogDescription')}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.webhooks.namePlaceholder')}
                  className="bg-muted text-foreground"
                />
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  className="bg-muted text-foreground"
                />
                <div className="space-y-1">
                  {EVENTS.map((event) => (
                    <label key={event} className="flex items-center gap-2">
                      <Checkbox
                        checked={events.has(event)}
                        onCheckedChange={() => toggleEvent(event)}
                      />
                      <span className="text-sm text-foreground">{event}</span>
                    </label>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)} className="border-border">
                  {t('settings.webhooks.cancel')}
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={saving || !name.trim() || !url.trim()}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {t('settings.webhooks.create')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
