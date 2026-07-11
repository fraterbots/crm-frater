'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from '@/lib/i18n/use-translation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsPanelHead } from './settings-panel-head';

interface DayRow {
  day_of_week: number;
  is_active: boolean;
  start_time: string; // "HH:mm"
  end_time: string; // "HH:mm"
}

const DAY_KEYS = [
  'settings.businessHours.sunday',
  'settings.businessHours.monday',
  'settings.businessHours.tuesday',
  'settings.businessHours.wednesday',
  'settings.businessHours.thursday',
  'settings.businessHours.friday',
  'settings.businessHours.saturday',
] as const;

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

function defaultRows(): DayRow[] {
  return Array.from({ length: 7 }, (_, day_of_week) => ({
    day_of_week,
    is_active: day_of_week >= 1 && day_of_week <= 5,
    start_time: '09:00',
    end_time: '18:00',
  }));
}

/**
 * Weekly business-hours editor. Persisted as up to 7 rows in
 * `business_hours` (one per weekday, UNIQUE(account_id, day_of_week) —
 * migration 038). No rows at all = "always within business hours"
 * (permissive default, see `is_within_business_hours()`), so an empty
 * state here is valid and not an error.
 */
export function BusinessHoursManager() {
  const supabase = createClient();
  const { accountId } = useAuth();
  const { t } = useTranslation();

  const [rows, setRows] = useState<DayRow[]>(defaultRows());
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('business_hours')
      .select('*')
      .eq('account_id', accountId);
    if (!error && data && data.length > 0) {
      setTimezone(data[0].timezone);
      setRows((prev) =>
        prev.map((row) => {
          const found = data.find((d) => d.day_of_week === row.day_of_week);
          return found
            ? {
                day_of_week: row.day_of_week,
                is_active: found.is_active,
                start_time: found.start_time.slice(0, 5),
                end_time: found.end_time.slice(0, 5),
              }
            : { ...row, is_active: false };
        }),
      );
    }
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  function updateRow(dayOfWeek: number, patch: Partial<DayRow>) {
    setRows((prev) =>
      prev.map((row) => (row.day_of_week === dayOfWeek ? { ...row, ...patch } : row)),
    );
  }

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);
    const { error } = await supabase.from('business_hours').upsert(
      rows.map((row) => ({
        account_id: accountId,
        day_of_week: row.day_of_week,
        is_active: row.is_active,
        start_time: row.start_time,
        end_time: row.end_time,
        timezone,
      })),
      { onConflict: 'account_id,day_of_week' },
    );
    setSaving(false);

    if (error) {
      toast.error(t('settings.businessHours.errorSave'));
      return;
    }
    toast.success(t('settings.businessHours.saved'));
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('settings.businessHours.title')}
        description={t('settings.businessHours.description')}
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.businessHours.loading')}
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {t('settings.businessHours.timezone')}
              </span>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="h-8 max-w-56 bg-muted text-foreground"
                placeholder="America/Sao_Paulo"
              />
            </div>

            <div className="space-y-1">
              {rows.map((row, idx) => (
                <div key={row.day_of_week} className="flex items-center gap-3 py-1">
                  <label className="flex w-40 shrink-0 items-center gap-2">
                    <Checkbox
                      checked={row.is_active}
                      onCheckedChange={() =>
                        updateRow(row.day_of_week, { is_active: !row.is_active })
                      }
                    />
                    <span className="text-sm text-foreground">{t(DAY_KEYS[idx])}</span>
                  </label>
                  <Input
                    type="time"
                    value={row.start_time}
                    disabled={!row.is_active}
                    onChange={(e) => updateRow(row.day_of_week, { start_time: e.target.value })}
                    className="h-8 w-32 bg-muted text-foreground"
                  />
                  <span className="text-sm text-muted-foreground">—</span>
                  <Input
                    type="time"
                    value={row.end_time}
                    disabled={!row.is_active}
                    onChange={(e) => updateRow(row.day_of_week, { end_time: e.target.value })}
                    className="h-8 w-32 bg-muted text-foreground"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t('settings.businessHours.save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
