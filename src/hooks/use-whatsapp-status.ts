import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export interface WhatsAppChannelStatus {
  provider: 'meta_cloud' | 'evolution';
  connected: boolean;
}

/**
 * Live "is WhatsApp actually connected" check — the ONE place that
 * should ever answer this question. Never trust `whatsapp_config.status`
 * directly: for Evolution it's updated by the CONNECTION_UPDATE webhook
 * and can lag/flap through transient Baileys reconnect states; for Meta
 * it's a "was configured successfully" flag frozen at save time, not a
 * live signal. Instead this always calls the right per-provider health
 * endpoint — `/api/whatsapp/evolution/status` (pings the Evolution API
 * live and self-heals the DB column) or `/api/whatsapp/config` (pings
 * Meta live) — for EVERY configured channel, since an account can have
 * both a Meta and an Evolution row at once (Fase 17/18, coexistence).
 *
 * Extracted so the inbox's "not connected" banner and the Settings
 * overview tile can't drift out of sync with each other again — before
 * this hook, the banner read the raw column directly and the overview
 * tile had its own (correct, but single-channel) inline version.
 */
export function useWhatsAppStatus(accountId: string | null): {
  channels: WhatsAppChannelStatus[];
  /** True if at least one configured channel is live — what the inbox
   *  banner cares about ("is *some* WhatsApp connection working"). */
  anyConnected: boolean;
  loading: boolean;
} {
  const [channels, setChannels] = useState<WhatsAppChannelStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      if (!accountId) {
        setChannels([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      const { data: rows } = await supabase
        .from('whatsapp_config')
        .select('provider, phone_number_id')
        .eq('account_id', accountId);
      if (cancelled) return;

      const configuredRows = (rows ?? []).filter(
        (row) => row.provider === 'evolution' || !!row.phone_number_id,
      );

      const results = await Promise.all(
        configuredRows.map(async (row) => {
          const provider = row.provider as 'meta_cloud' | 'evolution';
          const healthUrl =
            provider === 'evolution' ? '/api/whatsapp/evolution/status' : '/api/whatsapp/config';
          const health = await fetch(healthUrl, { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => null);
          return { provider, connected: !!health?.connected };
        }),
      );
      if (cancelled) return;

      setChannels(results);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { channels, anyConnected: channels.some((c) => c.connected), loading };
}
