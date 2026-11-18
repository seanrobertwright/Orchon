// PROTOTYPE. Metrics section UI in Orca components (#31).

import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  KeyValue,
  Link,
  List,
  ListItem,
  Progress,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Spinner,
  Stack,
  Tab,
  Table,
  Tabs,
  Text,
  plugin,
} from 'orca'
import type { PanelContext, TableColumn, TableRow } from 'orca'
import type {
  CalibrationBadge,
  CardViewModel,
  Focus,
  MetricDetailView,
  MetricsTab,
  MetricsViewPayload,
  Remote,
  Scenario,
  Variant,
  WindowDays,
} from './protocol'

const variantAtom = atom<Variant>('variant', 'A')
const scenarioAtom = atom<Scenario>('scenario', 'normal')
const tabAtom = atom<MetricsTab>('tab', 'overview')
const windowAtom = atom<WindowDays>('window', '7d')
const selectedMetricAtom = atom<string | null>('selectedMetric', null)
const byDayOpenAtom = atom<boolean>('byDayOpen', false)
const focusAtom = atom<Focus>('focus', 'all')
const lastActionAtom = atom<string>('lastAction', 'Ready')

const viewAtom = atom<MetricsViewPayload | null>(null)
const detailAtom = atom<MetricDetailView | null>(null)

async function refreshView() {
  const scenario = read(scenarioAtom)
  const window = read(windowAtom)
  const view = await plugin.request('metrics.view', { scenario, window })
  set(viewAtom, view)

  const selected = read(selectedMetricAtom)
  if (selected) {
    const detail = await plugin.request('metrics.detail', { scenario, window, name: selected })
    set(detailAtom, detail)
  } else {
    set(detailAtom, null)
  }
}

async function selectMetric(name: string | null) {
  set(selectedMetricAtom, name)
  if (!name) {
    set(detailAtom, null)
    return
  }
  const detail = await plugin.request('metrics.detail', {
    scenario: read(scenarioAtom),
    window: read(windowAtom),
    name,
  })
  set(detailAtom, detail)
}

async function applyRemote(remote: Remote) {
  set(variantAtom, remote.variant ?? 'A')
  set(scenarioAtom, remote.scenario ?? 'normal')
  set(tabAtom, remote.tab ?? 'overview')
  set(windowAtom, remote.window ?? '7d')
  set(selectedMetricAtom, remote.metric ?? null)
  set(byDayOpenAtom, remote.byDayOpen ?? false)
  set(focusAtom, remote.focus ?? 'all')
  await refreshView()
}

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(
    plugin.on('proto.set', (remote) => {
      void applyRemote(remote)
    }),
  )

  void (async () => {
    const saved = await plugin.request('proto.get')
    if (saved && Object.keys(saved).length > 0) {
      await applyRemote(saved)
    } else {
      await refreshView()
    }
  })()
}

function renderCalibrationBadge(cal: CalibrationBadge | null) {
  if (!cal) return null
  if (cal.state === 'ok') return <Badge tone="success">{cal.text}</Badge>
  if (cal.state === 'rough') return <Badge tone="warning">{cal.text}</Badge>
  if (cal.state === 'not_calibrated') return <Badge tone="warning">not calibrated</Badge>
  if (cal.state === 'loading') return <Badge tone="neutral">calibration loading</Badge>
  return <Badge tone="warning">calibration unavailable</Badge>
}

function MetricCard({
  card,
  variant,
  loadingInitial,
  onOpenDetails,
}: {
  card: CardViewModel
  variant: Variant
  loadingInitial: boolean
  onOpenDetails: (metric: string) => void
}) {
  if (loadingInitial) {
    return (
      <Card title={card.title}>
        <Stack gap="xs">
          <Skeleton shape="text" lines={2} label={`Loading ${card.title}`} />
        </Stack>
      </Card>
    )
  }

  if (card.shape === 'unknown') {
    return (
      <Card title={card.title}>
        <Text muted size="xs">
          This card needs a newer version of Orchon.
        </Text>
      </Card>
    )
  }

  const figureLevel = variant === 'A' ? 2 : 1

  if (card.shape === 'count') {
    return (
      <Card title={card.title}>
        <Stack gap="xs">
          <Heading level={figureLevel}>{card.figure}</Heading>
          {card.noRecords ? (
            <Text muted size="xs">
              no records in this window
            </Text>
          ) : (
            card.breakdown.length > 0 && (
              <Text muted={variant === 'A'} size="xs">
                {card.breakdown.map((b) => b.text).join(' · ')}
              </Text>
            )
          )}
          <Link onPress={() => onOpenDetails(card.metric)}>Details</Link>
        </Stack>
      </Card>
    )
  }

  if (card.shape === 'ratio') {
    return (
      <Card title={card.title}>
        <Stack gap="xs">
          {variant === 'A' ? (
            <Row justify="between" align="center" gap="xs" wrap>
              <Heading level={figureLevel}>{card.figure}</Heading>
              {renderCalibrationBadge(card.calibration)}
            </Row>
          ) : (
            <Stack gap="xs">
              <Heading level={figureLevel}>{card.figure}</Heading>
              {renderCalibrationBadge(card.calibration)}
            </Stack>
          )}
          {card.percent !== null && (
            <Progress label={card.title} labelHidden value={card.percent} />
          )}
          {card.stateText && (
            <Text muted size="xs">
              {card.stateText}
            </Text>
          )}
          <Text muted={variant === 'A'} size="xs">
            {card.line}
          </Text>
          <Link onPress={() => onOpenDetails(card.metric)}>Details</Link>
        </Stack>
      </Card>
    )
  }

  return (
    <Card title={card.title}>
      <Stack gap="xs">
        <Heading level={figureLevel}>{card.figure}</Heading>
        <Text muted={variant === 'A'} size="xs">
          {card.coverageLine}
        </Text>
        <Link onPress={() => onOpenDetails(card.metric)}>Details</Link>
      </Stack>
    </Card>
  )
}

function MetricDetailBlock({
  detail,
  variant,
  byDayOpen,
  onToggleByDay,
  onBack,
}: {
  detail: MetricDetailView
  variant: Variant
  byDayOpen: boolean
  onToggleByDay: (open: boolean) => void
  onBack: () => void
}) {
  const items = [
    { label: 'Metric', value: detail.name },
    ...(detail.judgeVersion ? [{ label: 'Judge version', value: detail.judgeVersion }] : []),
    { label: 'Value', value: detail.valueAndInterval },
    { label: 'Records', value: String(detail.records) },
    { label: 'Known cost', value: detail.knownCostSummary },
    ...(detail.costGaps ? [{ label: 'Cost gaps', value: detail.costGaps }] : []),
    ...(detail.tokensSummary ? [{ label: 'Tokens', value: detail.tokensSummary }] : []),
    { label: 'Latest', value: detail.latestSummary },
  ]

  const byDayColumns: TableColumn[] = [
    { key: 'day', label: 'Day (UTC)', width: 'sm' },
    { key: 'value', label: 'Value', align: 'end', width: 'xs' },
    { key: 'records', label: 'Records', align: 'end', width: 'xs' },
  ]

  const byDayRows: TableRow[] = detail.byDay.map((r) => ({
    key: r.day,
    cells: {
      day: r.day,
      value: r.valueText,
      records: r.records,
    },
  }))

  return (
    <Stack gap="sm">
      <Row justify="between" align="center" gap="xs" wrap>
        {variant === 'A' ? (
          <Button variant="ghost" size="xs" onPress={onBack}>
            ← Back to metrics
          </Button>
        ) : (
          <Heading level={2}>{detail.plainName}</Heading>
        )}
        {variant === 'B' && <Link onPress={onBack}>Close</Link>}
      </Row>

      {variant === 'A' && <Heading level={2}>{detail.plainName}</Heading>}

      <KeyValue label="Metric figures" items={items} />

      {detail.roughExplanation && (
        <Callout tone="warning" title="Rough calibration">
          <Text size="xs">{detail.roughExplanation}</Text>
        </Callout>
      )}

      {detail.calibrations.length > 0 && (
        <Stack gap="xs">
          <Text weight="semibold" size="xs">
            Calibrations
          </Text>
          {detail.calibrations.map((line, i) => (
            <Text key={i} size="xs" muted>
              {line}
            </Text>
          ))}
          {detail.calibrationsMore > 0 && (
            <Text size="xs" muted>
              and {detail.calibrationsMore} more in Archon's console
            </Text>
          )}
        </Stack>
      )}

      {detail.olderVersions.length > 0 && (
        <Stack gap="xs">
          <Text weight="semibold" size="xs">
            Older judge versions
          </Text>
          {detail.olderVersions.map((line, i) => (
            <Text key={i} size="xs" muted>
              {line}
            </Text>
          ))}
          {detail.olderVersionsMore > 0 && (
            <Text size="xs" muted>
              and {detail.olderVersionsMore} more in Archon's console
            </Text>
          )}
        </Stack>
      )}

      <Collapsible
        title={`By day (${detail.byDay.length} days)`}
        open={byDayOpen}
        onChange={onToggleByDay}
      >
        <Table
          label="By day"
          columns={byDayColumns}
          rows={byDayRows}
          maxHeight="md"
        />
      </Collapsible>
    </Stack>
  )
}

export default function MetricsPanel() {
  const variant = read(variantAtom)
  const scenario = read(scenarioAtom)
  const tab = read(tabAtom)
  const windowVal = read(windowAtom)
  const selectedMetric = read(selectedMetricAtom)
  const byDayOpen = read(byDayOpenAtom)
  const focus = read(focusAtom)
  const lastAction = read(lastActionAtom)
  const view = read(viewAtom)
  const detail = read(detailAtom)

  const handleOpenMetricFromCard = (metric: string) => {
    set(tabAtom, 'details')
    set(lastActionAtom, `Opened Details for ${metric}`)
    void selectMetric(metric)
  }

  const detailsColumns: TableColumn[] = [
    { key: 'name', label: 'Metric', minWidth: 'sm' },
    { key: 'value', label: 'Value', align: 'end', minWidth: 'xs' },
    { key: 'records', label: 'Records', align: 'end', width: 'xs', hideBelow: 'sm' },
    { key: 'knownCost', label: 'Known cost', align: 'end', width: 'sm', hideBelow: 'sm' },
    { key: 'latest', label: 'Latest', align: 'end', width: 'md', hideBelow: 'md' },
  ]

  const detailsRows: TableRow[] = (view?.rows ?? []).map((r) => ({
    key: r.name,
    cells: {
      name: r.plainName,
      value: r.valueText,
      records: r.recordsText,
      knownCost: r.knownCostText,
      latest: r.latestText,
    },
  }))

  const windowOptions =
    variant === 'A'
      ? [
          { value: '7d', label: '7d' },
          { value: '30d', label: '30d' },
          { value: '90d', label: '90d' },
        ]
      : [
          { value: '7d', label: '7 days' },
          { value: '30d', label: '30 days' },
          { value: '90d', label: '90 days' },
        ]

  return (
    <Box padding="sm">
      <Stack gap="sm">
        {focus === 'all' && (
          <Box padding="xs" border radius="sm" background="muted">
            <Stack gap="xs">
              <Row justify="between" align="center" gap="xs" wrap>
                <Text size="xs" weight="semibold">
                  PROTOTYPE (#31)
                </Text>
                <Row gap="xs">
                  <Button
                    size="xs"
                    variant={variant === 'A' ? 'solid' : 'outline'}
                    onPress={() => set(variantAtom, 'A')}
                  >
                    Variant A
                  </Button>
                  <Button
                    size="xs"
                    variant={variant === 'B' ? 'solid' : 'outline'}
                    onPress={() => set(variantAtom, 'B')}
                  >
                    Variant B
                  </Button>
                </Row>
              </Row>
              <Select
                label="Scenario"
                labelHidden
                value={scenario}
                options={[
                  { value: 'normal', label: 'Scenario: normal (1 pack, 3 cards)' },
                  { value: 'states', label: 'Scenario: all states, 2 packs & trouble' },
                  { value: 'loading-initial', label: 'Scenario: initial loading skeletons' },
                  { value: 'loading-window', label: 'Scenario: switching window (spinner)' },
                  { value: 'empty-packs', label: 'Scenario: no packs declare cards' },
                ]}
                onChange={(val) => {
                  set(scenarioAtom, val as Scenario)
                  set(selectedMetricAtom, null)
                  void refreshView()
                }}
              />
            </Stack>
          </Box>
        )}

        {focus === 'all' && view && (
          <Stack gap="xs">
            <Row justify="between" align="center" gap="xs" wrap>
              <RadioGroup
                label="Window"
                orientation="horizontal"
                value={windowVal}
                options={windowOptions}
                onChange={(val) => {
                  set(windowAtom, val as WindowDays)
                  set(lastActionAtom, `Window -> ${val}`)
                  void refreshView()
                }}
              />
              {variant === 'A' ? (
                <IconButton
                  icon="refresh"
                  label="Refresh metrics"
                  size="xs"
                  variant="ghost"
                  onPress={() => {
                    set(lastActionAtom, 'Refreshed metrics')
                    void refreshView()
                  }}
                />
              ) : (
                <Button
                  icon="refresh"
                  size="xs"
                  variant="outline"
                  onPress={() => {
                    set(lastActionAtom, 'Refreshed metrics')
                    void refreshView()
                  }}
                >
                  Refresh
                </Button>
              )}
            </Row>

            <Row gap="xs" align="center" wrap>
              <Text muted size="xs">
                {view.windowLabel} · {view.dateRange} · updated{' '}
                <RelativeTime at={view.updatedAt} muted />
              </Text>
            </Row>

            {variant === 'A' ? (
              <Row justify="between" align="center" gap="xs" wrap>
                <Tabs
                  label="Metrics view"
                  value={tab}
                  onChange={(val) => {
                    set(tabAtom, val as MetricsTab)
                    set(lastActionAtom, `Switched to ${val}`)
                  }}
                >
                  <Tab value="overview" label="Overview" />
                  <Tab value="details" label="Details" />
                </Tabs>
                <Link
                  onPress={() =>
                    set(lastActionAtom, `Open in Archon console (${tab}, ${windowVal})`)
                  }
                >
                  Open in Archon console
                </Link>
              </Row>
            ) : (
              <Row justify="between" align="center" gap="xs" wrap>
                <Row gap="xs">
                  <Button
                    size="xs"
                    variant={tab === 'overview' ? 'solid' : 'outline'}
                    onPress={() => {
                      set(tabAtom, 'overview')
                      set(lastActionAtom, 'Switched to overview')
                    }}
                  >
                    Overview
                  </Button>
                  <Button
                    size="xs"
                    variant={tab === 'details' ? 'solid' : 'outline'}
                    onPress={() => {
                      set(tabAtom, 'details')
                      set(lastActionAtom, 'Switched to details')
                    }}
                  >
                    Details
                  </Button>
                </Row>
                <Link
                  onPress={() =>
                    set(lastActionAtom, `Open in Archon console (${tab}, ${windowVal})`)
                  }
                >
                  Open in Archon console
                </Link>
              </Row>
            )}

            {view.loadingWindow && (
              <Row gap="xs" align="center">
                <Spinner label="Loading window" labelHidden />
                <Text size="xs" muted>
                  {view.loadingWindow.loadingLabel} {view.loadingWindow.showingLabel}
                </Text>
              </Row>
            )}
          </Stack>
        )}

        <Separator />

        {view && tab === 'overview' && (
          <Stack gap="sm">
            {view.refusedCount > 0 && (
              <Callout tone="danger" title={`${view.refusedCount} refused metric outputs`}>
                <Stack gap="xs">
                  <Text size="xs">
                    Archon could not store some metric records in this window.
                  </Text>
                  <Link
                    onPress={() => {
                      set(tabAtom, 'details')
                      set(lastActionAtom, 'Jumped to refusals in Details')
                    }}
                  >
                    Details
                  </Link>
                </Stack>
              </Callout>
            )}

            {view.unreadablePacks.map((err, i) => (
              <Callout key={i} tone="warning" title={`Unreadable pack: ${err.pack}`}>
                <Text size="xs">
                  {err.source}: {err.error}
                </Text>
              </Callout>
            ))}

            {view.packs.length === 0 ? (
              <EmptyState
                title="No pack declares overview cards."
                description="Metrics recorded in this window are still listed in Details."
                icon="bar-chart-3"
              >
                <Button
                  size="xs"
                  variant="outline"
                  onPress={() => set(tabAtom, 'details')}
                >
                  Open Details
                </Button>
              </EmptyState>
            ) : (
              view.packs.map((pack) => (
                <Stack key={pack.pack} gap="xs">
                  {view.packs.length > 1 && <Heading level={3}>{pack.pack}</Heading>}
                  <Grid minItemWidth={variant === 'A' ? 'sm' : 'md'} gap={variant === 'A' ? 'sm' : 'md'}>
                    {pack.cards.map((card) => (
                      <MetricCard
                        key={card.id}
                        card={card}
                        variant={variant}
                        loadingInitial={view.loadingInitial}
                        onOpenDetails={handleOpenMetricFromCard}
                      />
                    ))}
                  </Grid>
                </Stack>
              ))
            )}

            {view.packsMore > 0 && (
              <Text muted size="xs">
                and {view.packsMore} more in Archon's console
              </Text>
            )}
          </Stack>
        )}

        {view && tab === 'details' && (
          <Stack gap="sm">
            {!(variant === 'A' && detail) && (
              <>
                {view.refusals.length > 0 && (
                  <Stack gap="xs">
                    <Heading level={3}>Refused outputs</Heading>
                    <List label="Refused outputs">
                      {view.refusals.map((refusal) => (
                        <ListItem
                          key={refusal.runId}
                          title={`${refusal.workflow} · ${refusal.node}`}
                          description={refusal.reason}
                          icon="warning"
                          onPress={() =>
                            set(lastActionAtom, `Open run detail ${refusal.runId}`)
                          }
                        />
                      ))}
                    </List>
                    {view.refusalsMore > 0 && (
                      <Text muted size="xs">
                        and {view.refusalsMore} more in Archon's console
                      </Text>
                    )}
                  </Stack>
                )}

                <Table
                  label="Metrics"
                  columns={detailsColumns}
                  rows={detailsRows}
                  selectionMode="single"
                  selected={selectedMetric ? [selectedMetric] : []}
                  onRowAction={(row) => {
                    const found = view.rows.find((r) => r.name === row.key)
                    if (found?.selectable) {
                      set(lastActionAtom, `Selected metric ${row.key}`)
                      void selectMetric(row.key)
                    } else {
                      set(lastActionAtom, `${row.key} has no detail view`)
                    }
                  }}
                />

                {view.rowsMore > 0 && (
                  <Text muted size="xs">
                    and {view.rowsMore} more in Archon's console
                  </Text>
                )}

                <Text muted size="xs">
                  Known cost is the cost of the runs that produced a metric's records, so the column
                  does not add up.
                </Text>

                {view.unattributedCalibrations.length > 0 && (
                  <Stack gap="xs">
                    <Text weight="semibold" size="xs">
                      Calibrations without records in this window
                    </Text>
                    {view.unattributedCalibrations.map((c) => (
                      <Text key={c.name} muted size="xs">
                        {c.name}: {c.status}
                      </Text>
                    ))}
                  </Stack>
                )}
              </>
            )}

            {detail && (
              <>
                {variant === 'B' && <Separator />}
                <MetricDetailBlock
                  detail={detail}
                  variant={variant}
                  byDayOpen={byDayOpen}
                  onToggleByDay={(open) => set(byDayOpenAtom, open)}
                  onBack={() => {
                    set(lastActionAtom, 'Closed metric view')
                    void selectMetric(null)
                  }}
                />
              </>
            )}
          </Stack>
        )}

        {focus === 'all' && (
          <>
            <Separator />
            <Text muted size="xs">
              Last action: {lastAction}
            </Text>
          </>
        )}
      </Stack>
    </Box>
  )
}
