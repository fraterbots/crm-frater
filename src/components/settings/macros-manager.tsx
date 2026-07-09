'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GripVertical, Loader2, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import type {
  CannedResponse,
  ConversationStatus,
  Macro,
  MacroAction,
  Profile,
  Tag,
} from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ACTION_TYPES = ['assign_agent', 'add_tag', 'change_status', 'send_canned_response'] as const;
const STATUS_VALUES: ConversationStatus[] = ['open', 'pending', 'snoozed', 'closed'];

interface FormData {
  name: string;
  actions: MacroAction[];
}

const emptyForm: FormData = { name: '', actions: [] };

function defaultActionFor(
  type: MacroAction['type'],
  profiles: Profile[],
  tags: Tag[],
  cannedResponses: CannedResponse[],
): MacroAction {
  switch (type) {
    case 'assign_agent':
      return { type, agent_id: profiles[0]?.user_id ?? '' };
    case 'add_tag':
      return { type, tag_id: tags[0]?.id ?? '' };
    case 'change_status':
      return { type, status: 'closed' };
    case 'send_canned_response':
      return { type, canned_response_id: cannedResponses[0]?.id ?? '' };
  }
}

/**
 * Account-wide CRUD manager for macros — a name plus an ordered list
 * of actions an agent runs on a conversation with one click from the
 * inbox thread header. Actions are simple field mutations except
 * send_canned_response, which the run route (POST /api/macros/run)
 * executes via engineSendText — this UI just records which canned
 * response to use, it never sends anything itself.
 */
export function MacrosManager() {
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const { t } = useTranslation();

  const [macros, setMacros] = useState<Macro[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Macro | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [macrosRes, profilesRes, tagsRes, cannedRes] = await Promise.all([
      supabase.from('macros').select('*').order('name'),
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('tags').select('*').order('name'),
      supabase.from('canned_responses').select('*').order('title'),
    ]);
    if (macrosRes.error || profilesRes.error || tagsRes.error || cannedRes.error) {
      toast.error(t('settings.macros.errorLoad'));
    } else {
      setMacros((macrosRes.data as Macro[] | null) ?? []);
      setProfiles((profilesRes.data as Profile[] | null) ?? []);
      setTags((tagsRes.data as Tag[] | null) ?? []);
      setCannedResponses((cannedRes.data as CannedResponse[] | null) ?? []);
    }
    setLoading(false);
  }, [supabase, accountId, t]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  function actionTypeLabel(type: MacroAction['type']): string {
    switch (type) {
      case 'assign_agent':
        return t('settings.macros.actionTypes.assignAgent');
      case 'add_tag':
        return t('settings.macros.actionTypes.addTag');
      case 'change_status':
        return t('settings.macros.actionTypes.changeStatus');
      case 'send_canned_response':
        return t('settings.macros.actionTypes.sendCannedResponse');
    }
  }

  function statusLabel(status: ConversationStatus): string {
    switch (status) {
      case 'open':
        return t('inbox.conversationList.statusOpen');
      case 'pending':
        return t('inbox.conversationList.statusPending');
      case 'snoozed':
        return t('inbox.conversationList.statusSnoozed');
      case 'closed':
        return t('inbox.conversationList.statusClosed');
    }
  }

  function describeAction(action: MacroAction): string {
    switch (action.type) {
      case 'assign_agent':
        return profiles.find((p) => p.user_id === action.agent_id)?.full_name ?? action.agent_id;
      case 'add_tag':
        return tags.find((tg) => tg.id === action.tag_id)?.name ?? action.tag_id;
      case 'change_status':
        return statusLabel(action.status);
      case 'send_canned_response':
        return (
          cannedResponses.find((c) => c.id === action.canned_response_id)?.title ??
          action.canned_response_id
        );
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(macro: Macro) {
    setEditing(macro);
    setForm({ name: macro.name, actions: macro.actions });
    setDialogOpen(true);
  }

  function addAction() {
    setForm((f) => ({
      ...f,
      actions: [...f.actions, defaultActionFor('change_status', profiles, tags, cannedResponses)],
    }));
  }

  function removeAction(index: number) {
    setForm((f) => ({ ...f, actions: f.actions.filter((_, i) => i !== index) }));
  }

  function updateActionType(index: number, type: MacroAction['type']) {
    setForm((f) => ({
      ...f,
      actions: f.actions.map((a, i) =>
        i === index ? defaultActionFor(type, profiles, tags, cannedResponses) : a,
      ),
    }));
  }

  function updateActionValue(index: number, value: string) {
    setForm((f) => ({
      ...f,
      actions: f.actions.map((a, i) => {
        if (i !== index) return a;
        switch (a.type) {
          case 'assign_agent':
            return { ...a, agent_id: value };
          case 'add_tag':
            return { ...a, tag_id: value };
          case 'change_status':
            return { ...a, status: value as ConversationStatus };
          case 'send_canned_response':
            return { ...a, canned_response_id: value };
        }
      }),
    }));
  }

  function actionValue(action: MacroAction): string {
    switch (action.type) {
      case 'assign_agent':
        return action.agent_id;
      case 'add_tag':
        return action.tag_id;
      case 'change_status':
        return action.status;
      case 'send_canned_response':
        return action.canned_response_id;
    }
  }

  async function handleSave() {
    const name = form.name.trim();
    if (!name || form.actions.length === 0) return;
    if (!accountId || !user) {
      toast.error(t('settings.macros.errorNoAccount'));
      return;
    }

    setSaving(true);
    const { error } = editing
      ? await supabase.from('macros').update({ name, actions: form.actions }).eq('id', editing.id)
      : await supabase
          .from('macros')
          .insert({ account_id: accountId, created_by: user.id, name, actions: form.actions });
    setSaving(false);

    if (error) {
      toast.error(t('settings.macros.errorSave'));
      return;
    }
    toast.success(
      editing ? t('settings.macros.updated', { name }) : t('settings.macros.created', { name }),
    );
    setDialogOpen(false);
    await fetchAll();
  }

  async function handleDelete(macro: Macro) {
    if (!window.confirm(t('settings.macros.confirmDelete', { name: macro.name }))) return;
    setBusyId(macro.id);
    const { error } = await supabase.from('macros').delete().eq('id', macro.id);
    setBusyId(null);
    if (error) {
      toast.error(t('settings.macros.errorDelete'));
      return;
    }
    toast.success(t('settings.macros.deleted', { name: macro.name }));
    await fetchAll();
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.macros.title')}
        description={t('settings.macros.description')}
        action={
          <Button
            onClick={openCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            {t('settings.macros.add')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.macros.loading')}
        </div>
      ) : macros.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.macros.noMacrosYet')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {macros.map((macro) => (
            <Card key={macro.id}>
              <CardContent className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Zap className="size-4 text-muted-foreground" />
                    <span className="font-medium text-foreground">{macro.name}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {macro.actions
                      .map((a) => `${actionTypeLabel(a.type)}: ${describeAction(a)}`)
                      .join(' → ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === macro.id}
                    onClick={() => openEdit(macro)}
                    title={t('settings.macros.editTitle')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === macro.id}
                    onClick={() => handleDelete(macro)}
                    title={t('settings.macros.deleteTitle')}
                    className="text-muted-foreground hover:text-red-400"
                  >
                    {busyId === macro.id ? (
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
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editing ? t('settings.macros.editDialogTitle') : t('settings.macros.newDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('settings.macros.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('settings.macros.namePlaceholder')}
              className="bg-muted text-foreground"
            />

            <div className="max-h-72 space-y-2 overflow-y-auto">
              {form.actions.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('settings.macros.noActionsYet')}
                </p>
              ) : (
                form.actions.map((action, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 rounded-md border border-border p-2"
                  >
                    <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                    <Select
                      value={action.type}
                      onValueChange={(val) => updateActionType(index, val as MacroAction['type'])}
                    >
                      <SelectTrigger className="w-40 shrink-0 border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        {ACTION_TYPES.map((type) => (
                          <SelectItem
                            key={type}
                            value={type}
                            className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                          >
                            {actionTypeLabel(type)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Select
                      value={actionValue(action)}
                      onValueChange={(val) => val && updateActionValue(index, val)}
                    >
                      <SelectTrigger className="flex-1 border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        {action.type === 'assign_agent' &&
                          profiles.map((p) => (
                            <SelectItem
                              key={p.user_id}
                              value={p.user_id}
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {p.full_name}
                            </SelectItem>
                          ))}
                        {action.type === 'add_tag' &&
                          tags.map((tg) => (
                            <SelectItem
                              key={tg.id}
                              value={tg.id}
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {tg.name}
                            </SelectItem>
                          ))}
                        {action.type === 'change_status' &&
                          STATUS_VALUES.map((status) => (
                            <SelectItem
                              key={status}
                              value={status}
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {statusLabel(status)}
                            </SelectItem>
                          ))}
                        {action.type === 'send_canned_response' &&
                          cannedResponses.map((c) => (
                            <SelectItem
                              key={c.id}
                              value={c.id}
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {c.title}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeAction(index)}
                      className="shrink-0 text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <Button
              variant="outline"
              onClick={addAction}
              className="w-full border-border border-dashed"
            >
              <Plus className="size-4" />
              {t('settings.macros.addAction')}
            </Button>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border"
            >
              {t('settings.macros.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || form.actions.length === 0}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('settings.macros.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
