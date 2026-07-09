'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import type { CannedResponse } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface FormData {
  shortcut: string;
  title: string;
  body: string;
}

const emptyForm: FormData = { shortcut: '', title: '', body: '' };

/**
 * Account-wide CRUD manager for canned responses — free-text snippets
 * an agent inserts into the inbox composer. Distinct from
 * `TemplateManager` (Meta-approved WhatsApp templates): no approval
 * workflow, no Meta involvement, editable by any agent.
 */
export function CannedResponsesManager() {
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const { t } = useTranslation();

  const [responses, setResponses] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CannedResponse | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchResponses = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('canned_responses')
      .select('*')
      .order('title');
    if (error) {
      toast.error(t('settings.cannedResponses.errorLoad'));
    } else {
      setResponses((data as CannedResponse[] | null) ?? []);
    }
    setLoading(false);
  }, [supabase, accountId, t]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchResponses();
    }
  }, [accountId, fetchResponses]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(response: CannedResponse) {
    setEditing(response);
    setForm({ shortcut: response.shortcut, title: response.title, body: response.body });
    setDialogOpen(true);
  }

  async function handleSave() {
    const shortcut = form.shortcut.trim();
    const title = form.title.trim();
    const body = form.body.trim();
    if (!shortcut || !title || !body) return;
    if (!accountId || !user) {
      toast.error(t('settings.cannedResponses.errorNoAccount'));
      return;
    }

    setSaving(true);
    const { error } = editing
      ? await supabase
          .from('canned_responses')
          .update({ shortcut, title, body })
          .eq('id', editing.id)
      : await supabase.from('canned_responses').insert({
          account_id: accountId,
          created_by: user.id,
          shortcut,
          title,
          body,
        });
    setSaving(false);

    if (error) {
      toast.error(
        error.code === '23505'
          ? t('settings.cannedResponses.errorDuplicateShortcut')
          : t('settings.cannedResponses.errorSave'),
      );
      return;
    }

    toast.success(
      editing
        ? t('settings.cannedResponses.updated', { title })
        : t('settings.cannedResponses.created', { title }),
    );
    setDialogOpen(false);
    await fetchResponses();
  }

  async function handleDelete(response: CannedResponse) {
    if (!window.confirm(t('settings.cannedResponses.confirmDelete', { title: response.title }))) {
      return;
    }
    setBusyId(response.id);
    const { error } = await supabase.from('canned_responses').delete().eq('id', response.id);
    setBusyId(null);
    if (error) {
      toast.error(t('settings.cannedResponses.errorDelete'));
      return;
    }
    toast.success(t('settings.cannedResponses.deleted', { title: response.title }));
    await fetchResponses();
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.cannedResponses.title')}
        description={t('settings.cannedResponses.description')}
        action={
          <Button
            onClick={openCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            {t('settings.cannedResponses.add')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.cannedResponses.loading')}
        </div>
      ) : responses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.cannedResponses.noResponsesYet')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {responses.map((response) => (
            <Card key={response.id}>
              <CardContent className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{response.title}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      /{response.shortcut}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {response.body}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === response.id}
                    onClick={() => openEdit(response)}
                    title={t('settings.cannedResponses.editTitle')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === response.id}
                    onClick={() => handleDelete(response)}
                    title={t('settings.cannedResponses.deleteTitle')}
                    className="text-muted-foreground hover:text-red-400"
                  >
                    {busyId === response.id ? (
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
              {editing
                ? t('settings.cannedResponses.editDialogTitle')
                : t('settings.cannedResponses.newDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('settings.cannedResponses.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="canned-title">{t('settings.cannedResponses.fieldTitle')}</Label>
              <Input
                id="canned-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder={t('settings.cannedResponses.fieldTitlePlaceholder')}
                className="bg-muted text-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="canned-shortcut">{t('settings.cannedResponses.fieldShortcut')}</Label>
              <Input
                id="canned-shortcut"
                value={form.shortcut}
                onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value }))}
                placeholder={t('settings.cannedResponses.fieldShortcutPlaceholder')}
                className="bg-muted text-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="canned-body">{t('settings.cannedResponses.fieldBody')}</Label>
              <Textarea
                id="canned-body"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder={t('settings.cannedResponses.fieldBodyPlaceholder')}
                rows={4}
                className="bg-muted text-foreground"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border"
            >
              {t('settings.cannedResponses.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.shortcut.trim() || !form.title.trim() || !form.body.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('settings.cannedResponses.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
