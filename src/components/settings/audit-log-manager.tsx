'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Loader2, ShieldAlert } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import type { Profile } from '@/types';
import type { TranslationKey } from '@/lib/i18n/dictionaries';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SettingsPanelHead } from './settings-panel-head';

const PAGE_SIZE = 25;

interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_LABEL: Record<string, TranslationKey> = {
  'conversation.assigned': 'settings.auditLog.actionAssigned',
  'conversation.status_changed': 'settings.auditLog.actionStatusChanged',
  'contact.deleted': 'settings.auditLog.actionContactDeleted',
};

function describe(row: AuditLogRow): string {
  if (row.action === 'conversation.assigned') {
    return `${(row.before?.assigned_agent_id as string) ?? '—'} → ${(row.after?.assigned_agent_id as string) ?? '—'}`;
  }
  if (row.action === 'conversation.status_changed') {
    return `${(row.before?.status as string) ?? '—'} → ${(row.after?.status as string) ?? '—'}`;
  }
  if (row.action === 'contact.deleted') {
    return (row.before?.name as string) || (row.before?.phone as string) || '';
  }
  return '';
}

/**
 * Read-only viewer for `audit_logs` (migration 039) — rows are written
 * exclusively by SECURITY DEFINER triggers (conversation assignment /
 * status changes, contact deletion), never by client code. Gated to
 * admin+ both here (UX) and by RLS (`audit_logs_select`, real
 * enforcement) — this client-side check is just to avoid flashing an
 * empty table at agents who simply get zero rows back from RLS.
 */
export function AuditLogManager() {
  const supabase = createClient();
  const { accountId, canManageMembers } = useAuth();
  const { t, locale } = useTranslation();

  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const fetchAll = useCallback(async () => {
    if (!accountId || !canManageMembers) return;
    setLoading(true);
    const from = page * PAGE_SIZE;
    const [logsRes, profilesRes] = await Promise.all([
      supabase
        .from('audit_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1),
      supabase.from('profiles').select('*'),
    ]);
    if (logsRes.error) {
      toast.error(t('settings.auditLog.errorLoad'));
    } else {
      setRows((logsRes.data as AuditLogRow[] | null) ?? []);
      setTotalCount(logsRes.count ?? 0);
    }
    setProfiles((profilesRes.data as Profile[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId, canManageMembers, page, t]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  function actorName(userId: string | null): string {
    if (!userId) return t('settings.auditLog.systemActor');
    return profiles.find((p) => p.user_id === userId)?.full_name || userId;
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  if (!canManageMembers) {
    return (
      <div>
        <SettingsPanelHead
          title={t('settings.auditLog.title')}
          description={t('settings.auditLog.description')}
        />
        <Card>
          <CardContent className="flex items-center gap-3 py-12 text-sm text-muted-foreground">
            <ShieldAlert className="size-5" />
            {t('settings.auditLog.noAccess')}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.auditLog.title')}
        description={t('settings.auditLog.description')}
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.auditLog.loading')}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.auditLog.empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('settings.auditLog.colWhen')}</TableHead>
                <TableHead className="text-muted-foreground">{t('settings.auditLog.colActor')}</TableHead>
                <TableHead className="text-muted-foreground">{t('settings.auditLog.colAction')}</TableHead>
                <TableHead className="text-muted-foreground">{t('settings.auditLog.colDetails')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-border">
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(row.created_at).toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {actorName(row.actor_user_id)}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">
                    {ACTION_LABEL[row.action] ? t(ACTION_LABEL[row.action]) : row.action}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{describe(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 pt-3">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="border-border"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('settings.auditLog.pageOf', { page: page + 1, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="border-border"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
