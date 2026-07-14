'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Star } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsPanelHead } from './settings-panel-head';

interface CsatResponseRow {
  id: string;
  rating: number;
  created_at: string;
}

interface ChannelRow {
  id: string;
  provider: 'meta_cloud' | 'evolution';
  csat_enabled: boolean;
  csat_message: string | null;
}

const DEFAULT_MESSAGE =
  'Como você avalia nosso atendimento? Responda com um número de 1 (ruim) a 5 (ótimo).';

const PROVIDER_LABEL: Record<ChannelRow['provider'], string> = {
  meta_cloud: 'Oficial (Meta Cloud API)',
  evolution: 'Não-oficial (WhatsApp Web)',
};

/**
 * CSAT toggle + survey message, configured PER CHANNEL — an account
 * can have up to two whatsapp_config rows (Meta + Evolution) since
 * Fase 17/18 (coexistence), and closeConversationAndMaybeSendCsat
 * (src/lib/conversations/close.ts) now resolves csat_enabled/
 * csat_message via the CONVERSATION's own channel, not a bare
 * account-wide row. The satisfaction report below stays account-wide
 * (aggregated across every channel's responses).
 */
export function CsatManager() {
  const supabase = createClient();
  const { accountId } = useAuth();
  const { t } = useTranslation();

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { enabled: boolean; message: string }>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [responses, setResponses] = useState<CsatResponseRow[]>([]);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [channelsRes, responsesRes] = await Promise.all([
      supabase
        .from('whatsapp_config')
        .select('id, provider, csat_enabled, csat_message')
        .eq('account_id', accountId),
      supabase
        .from('csat_responses')
        .select('id, rating, created_at')
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    const rows = (channelsRes.data as ChannelRow[] | null) ?? [];
    setChannels(rows);
    setDrafts(
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          { enabled: row.csat_enabled, message: row.csat_message || DEFAULT_MESSAGE },
        ]),
      ),
    );
    setResponses((responsesRes.data as CsatResponseRow[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  async function handleSave(channelId: string) {
    const draft = drafts[channelId];
    if (!draft) return;
    setSavingId(channelId);
    const { error } = await supabase
      .from('whatsapp_config')
      .update({ csat_enabled: draft.enabled, csat_message: draft.message })
      .eq('id', channelId);
    setSavingId(null);
    if (error) {
      toast.error(t('settings.csat.errorSave'));
      return;
    }
    toast.success(t('settings.csat.saved'));
  }

  const total = responses.length;
  const average = total > 0 ? responses.reduce((sum, r) => sum + r.rating, 0) / total : 0;
  const distribution = [1, 2, 3, 4, 5].map(
    (score) => responses.filter((r) => r.rating === score).length,
  );
  const maxCount = Math.max(1, ...distribution);

  return (
    <div>
      <SettingsPanelHead title={t('settings.csat.title')} description={t('settings.csat.description')} />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.csat.loading')}
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.csat.notConfigured')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {channels.map((channel) => {
            const draft = drafts[channel.id] ?? { enabled: false, message: DEFAULT_MESSAGE };
            return (
              <Card key={channel.id}>
                <CardContent className="space-y-3">
                  <p className="text-sm font-medium text-foreground">
                    {PROVIDER_LABEL[channel.provider]}
                  </p>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={draft.enabled}
                      onCheckedChange={() =>
                        setDrafts((prev) => ({
                          ...prev,
                          [channel.id]: { ...draft, enabled: !draft.enabled },
                        }))
                      }
                    />
                    <span className="text-sm text-foreground">{t('settings.csat.enable')}</span>
                  </label>
                  <Textarea
                    value={draft.message}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [channel.id]: { ...draft, message: e.target.value },
                      }))
                    }
                    rows={3}
                    className="bg-muted text-foreground"
                    placeholder={DEFAULT_MESSAGE}
                  />
                  <div className="flex justify-end">
                    <Button
                      onClick={() => handleSave(channel.id)}
                      disabled={savingId === channel.id}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      {savingId === channel.id && <Loader2 className="size-4 animate-spin" />}
                      {t('settings.csat.save')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <Card>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Star className="size-4 text-amber-400" />
                <span className="text-lg font-semibold text-foreground">
                  {total > 0 ? average.toFixed(1) : '—'}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('settings.csat.responseCount', { count: total })}
                </span>
              </div>
              <div className="space-y-1">
                {distribution.map((count, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="w-4 text-xs text-muted-foreground">{idx + 1}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-amber-400"
                        style={{ width: `${(count / maxCount) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right text-xs text-muted-foreground">{count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
