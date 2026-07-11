'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Timer, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import type { SlaPolicy } from '@/types';
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

interface FormState {
  name: string;
  first_response_minutes: string;
  resolution_minutes: string;
  business_hours_only: boolean;
  is_default: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  first_response_minutes: '30',
  resolution_minutes: '480',
  business_hours_only: true,
  is_default: false,
};

/**
 * CRUD manager for `sla_policies` (migration 040). New conversations
 * pick up whichever policy has `is_default = true` (see
 * resolveDefaultSla in src/lib/whatsapp/inbound-message.ts) — the form
 * enforces at most one default via a DB partial unique index, mirrored
 * here by simply clearing the flag on every other row on save.
 */
export function SlaPoliciesManager() {
  const supabase = createClient();
  const { accountId } = useAuth();
  const { t } = useTranslation();

  const [policies, setPolicies] = useState<SlaPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SlaPolicy | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('sla_policies')
      .select('*')
      .order('name');
    if (error) {
      toast.error(t('settings.sla.errorLoad'));
    } else {
      setPolicies((data as SlaPolicy[] | null) ?? []);
    }
    setLoading(false);
  }, [supabase, accountId, t]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(policy: SlaPolicy) {
    setEditing(policy);
    setForm({
      name: policy.name,
      first_response_minutes: String(policy.first_response_minutes),
      resolution_minutes: String(policy.resolution_minutes),
      business_hours_only: policy.business_hours_only,
      is_default: policy.is_default,
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!accountId || !form.name.trim()) return;
    const firstResponse = parseInt(form.first_response_minutes, 10);
    const resolution = parseInt(form.resolution_minutes, 10);
    if (!firstResponse || !resolution) return;

    setSaving(true);

    // Clear any other default first — the partial unique index would
    // otherwise reject setting a second row as default.
    if (form.is_default) {
      await supabase
        .from('sla_policies')
        .update({ is_default: false })
        .eq('account_id', accountId)
        .eq('is_default', true);
    }

    const payload = {
      account_id: accountId,
      name: form.name.trim(),
      first_response_minutes: firstResponse,
      resolution_minutes: resolution,
      business_hours_only: form.business_hours_only,
      is_default: form.is_default,
    };

    const { error } = editing
      ? await supabase.from('sla_policies').update(payload).eq('id', editing.id)
      : await supabase.from('sla_policies').insert(payload);
    setSaving(false);

    if (error) {
      toast.error(t('settings.sla.errorSave'));
      return;
    }
    toast.success(t('settings.sla.saved'));
    setDialogOpen(false);
    await fetchAll();
  }

  async function handleDelete(policy: SlaPolicy) {
    if (!window.confirm(t('settings.sla.confirmDelete', { name: policy.name }))) return;
    setBusyId(policy.id);
    const { error } = await supabase.from('sla_policies').delete().eq('id', policy.id);
    setBusyId(null);
    if (error) {
      toast.error(t('settings.sla.errorDelete'));
      return;
    }
    toast.success(t('settings.sla.deleted', { name: policy.name }));
    await fetchAll();
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.sla.title')}
        description={t('settings.sla.description')}
        action={
          <Button onClick={openCreate} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="size-4" />
            {t('settings.sla.add')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.sla.loading')}
        </div>
      ) : policies.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.sla.noPoliciesYet')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {policies.map((policy) => (
            <Card key={policy.id}>
              <CardContent className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Timer className="size-4 text-muted-foreground" />
                    <span className="font-medium text-foreground">{policy.name}</span>
                    {policy.is_default && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        {t('settings.sla.defaultBadge')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('settings.sla.summary', {
                      first: policy.first_response_minutes,
                      resolution: policy.resolution_minutes,
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === policy.id}
                    onClick={() => openEdit(policy)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === policy.id}
                    onClick={() => handleDelete(policy)}
                    className="text-muted-foreground hover:text-red-400"
                  >
                    {busyId === policy.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editing ? t('settings.sla.editDialogTitle') : t('settings.sla.newDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('settings.sla.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('settings.sla.namePlaceholder')}
              className="bg-muted text-foreground"
            />
            <div className="flex items-center gap-2">
              <span className="w-48 text-sm text-muted-foreground">
                {t('settings.sla.firstResponseLabel')}
              </span>
              <Input
                type="number"
                min={1}
                value={form.first_response_minutes}
                onChange={(e) => setForm((f) => ({ ...f, first_response_minutes: e.target.value }))}
                className="h-8 bg-muted text-foreground"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-48 text-sm text-muted-foreground">
                {t('settings.sla.resolutionLabel')}
              </span>
              <Input
                type="number"
                min={1}
                value={form.resolution_minutes}
                onChange={(e) => setForm((f) => ({ ...f, resolution_minutes: e.target.value }))}
                className="h-8 bg-muted text-foreground"
              />
            </div>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={form.business_hours_only}
                onCheckedChange={() =>
                  setForm((f) => ({ ...f, business_hours_only: !f.business_hours_only }))
                }
              />
              <span className="text-sm text-foreground">{t('settings.sla.businessHoursOnly')}</span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={form.is_default}
                onCheckedChange={() => setForm((f) => ({ ...f, is_default: !f.is_default }))}
              />
              <span className="text-sm text-foreground">{t('settings.sla.setAsDefault')}</span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="border-border">
              {t('settings.sla.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('settings.sla.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
