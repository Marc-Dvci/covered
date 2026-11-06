// The coordinator's week on Bryntum Scheduler (Enterprise tier, the former Scheduler Pro). One row per member
// with their own working calendar, one bar per visit coloured by where its money is, travel to the next
// home as an event buffer, the agent's proposal as dashed bars. A drag asks the same solver as the agent:
// its verdicts are on hand while the bar is in the air, and the server checks again on the drop.
import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/scheduler-enterprise/scheduler.css";
import "@bryntum/scheduler-enterprise/svalbard-light.css";
import { ProjectModel, Scheduler, type EventModel, type ResourceModel, type SchedulerConfig } from "@bryntum/scheduler-enterprise";
import { useEffect, useRef, useState } from "react";
import { clock } from "../../../shared/domain.ts";
import { api, STATE_LABEL, type Board, type Guards } from "../api.ts";
import "./board-scheduler.css";

const FROM_HOUR = 7;
const TO_HOUR = 19;
const NEEDS_COVER = "needs-cover";

export type BoardView = { mode: "day"; day: number } | { mode: "week" };

const atDay = (weekStart: string, day: number, hour: number) => {
  const [y, m, d] = weekStart.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + day, hour);
};

const DAY_PRESET = {
  id: "covered-day", base: "hourAndDay", tickWidth: 70, displayDateFormat: "HH:mm",
  headers: [{ unit: "hour", dateFormat: "HH:mm" }],
};
const WEEK_PRESET = {
  id: "covered-week", base: "hourAndDay", tickWidth: 18, displayDateFormat: "ddd HH:mm",
  headers: [{ unit: "day", dateFormat: "ddd D MMM" }, { unit: "hour", increment: 3, dateFormat: "HH" }],
};

/** Nights are not part of a cooperative's day: the axis shows only 07:00 to 19:00, on the day and on the week. */
function workdayTicks(start: Date, end: Date): { startDate: Date; endDate: Date }[] {
  const ticks: { startDate: Date; endDate: Date }[] = [];
  for (let t = new Date(start); t < end; t = new Date(t.getTime() + 3600_000)) {
    if (t.getHours() >= FROM_HOUR && t.getHours() < TO_HOUR) ticks.push({ startDate: new Date(t), endDate: new Date(t.getTime() + 3600_000) });
  }
  return ticks;
}

interface Props {
  board: Board;
  view: BoardView;
  selected: string | null;
  onSelect: (visitId: string) => void;
  onMoved: (message: string) => void;
  onRefused: (message: string) => void;
}

interface Live extends Props {
  guards: Guards;
}

const clockOf = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const visitIdOf = (e: EventModel) => (e.get("visitId") as string | undefined) ?? String(e.id);

export function BoardScheduler(props: Props) {
  const { board, view, selected } = props;
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live>({ ...props, guards: {} });
  live.current = { ...live.current, ...props };
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);

  useEffect(() => {
    // each poll loads the week in CrudManager format; the stores apply only what changed, so moved bars animate
    const project = new ProjectModel({
      eventStore: { syncDataOnLoad: true },
      assignmentStore: { syncDataOnLoad: true },
      resourceStore: { syncDataOnLoad: true },
    } as never);
    const s = new Scheduler({ appendTo: host.current!, project, ...schedulerConfig(() => live.current) });
    (s as unknown as { foregroundCanvas?: HTMLElement }).foregroundCanvas?.setAttribute("role", "row");
    setScheduler(s);
    return () => {
      s.destroy();
      project.destroy();
    };
  }, []);

  const dataKey = JSON.stringify(board.crud);
  useEffect(() => {
    if (!scheduler) return;
    void (scheduler.project as ProjectModel).loadCrudManagerData(JSON.parse(dataKey)).then(() => {
      if (!scheduler.isDestroyed) scheduler.refreshRows();
    });
  }, [dataKey, scheduler]);

  // the guard's verdicts for the day on screen, refreshed whenever the week changes
  const guardDay = view.mode === "day" ? view.day : Math.floor(board.now / 1440);
  useEffect(() => {
    let current = true;
    void api<Guards>(`/api/board/guards?day=${guardDay}`).then((g) => {
      if (current) live.current.guards = g;
    });
    return () => {
      current = false;
    };
  }, [dataKey, guardDay]);

  const viewKey = view.mode === "day" ? `day-${view.day}` : "week";
  useEffect(() => {
    if (!scheduler) return;
    if (view.mode === "day") {
      scheduler.viewPreset = DAY_PRESET as never;
      scheduler.setTimeSpan(atDay(board.weekStart, view.day, 0), atDay(board.weekStart, view.day + 1, 0));
    } else {
      scheduler.viewPreset = WEEK_PRESET as never;
      scheduler.setTimeSpan(atDay(board.weekStart, 0, 0), atDay(board.weekStart, 6, 0));
    }
    scheduler.refreshRows();
  }, [viewKey, board.weekStart, scheduler]);

  useEffect(() => {
    if (!scheduler) return;
    const record = selected ? scheduler.eventStore.getById(selected) : null;
    if (record) scheduler.selectEvent(record as EventModel);
    else scheduler.clearEventSelection();
  }, [selected, scheduler]);

  return <div className="board-scheduler" ref={host} role="region" aria-label="The week on the board" />;
}

function schedulerConfig(now: () => Live): Partial<SchedulerConfig> {
  const memberName = (id: string) => now().board.members.find((m) => m.id === id)?.name ?? id;
  const verdicts = (visitId: string) => now().guards[visitId] ?? {};

  return {
    startDate: new Date(2026, 10, 19),
    endDate: new Date(2026, 10, 20),
    viewPreset: DAY_PRESET as never,
    rowHeight: 62,
    barMargin: 5,
    resourceMargin: 6,
    eventStyle: "plain" as never,
    eventColor: null as never,
    forceFit: true,
    useInitialAnimation: false,
    timeResolution: 5,
    zoomOnMouseWheel: false,
    zoomOnTimeAxisDoubleClick: false,
    timeAxis: { continuous: false, generateTicks: workdayTicks } as never,
    columns: [
      {
        text: "Member",
        field: "name",
        width: 214,
        sortable: false,
        groupable: false,
        draggable: false,
        htmlEncode: false,
        renderer: ({ record }: { record: unknown }) => memberCell(record as ResourceModel, now().board, now().view),
      } as never,
    ],

    eventRenderer: ({ eventRecord, renderData }: { eventRecord: EventModel; renderData: { iconCls: unknown; wrapperCls: unknown; role?: string; ariaLabel?: string } }) => {
      renderData.iconCls = "";
      // a grid's row group may hold rows only: the bars are the cells of the canvas's row (see below)
      renderData.role = "gridcell";
      const kind = eventRecord.get("kind") as string;
      (renderData.wrapperCls as Record<string, boolean>)[kind === "proposed" ? "bar-proposed" : `bar-${eventRecord.get("state") as string}`] = true;
      const line = kind === "proposed" ? (eventRecord.get("asked") ? "proposed, household asked first" : "proposed") : (eventRecord.get("chip") as string);
      renderData.ariaLabel = `${eventRecord.name}, ${clockOf(eventRecord.startDate as Date)} to ${clockOf(eventRecord.endDate as Date)}, ${line}`;
      return [
        { tag: "b", text: eventRecord.name },
        { tag: "span", text: `${clockOf(eventRecord.startDate as Date)} · ${line}` },
      ] as never;
    },

    features: {
      // ---- features that carry the product's rules
      eventBuffer: {
        showDuration: false,
        renderer: ({ postambleConfig }: { postambleConfig: { icon?: string } }) => {
          postambleConfig.icon = "fa fa-car-side";
        },
        tooltipTemplate: ({ duration }: { duration: string }) => `${duration} of travel to the next home`,
      },
      resourceNonWorkingTime: true,
      resourceTimeRanges: { tabIndex: null },
      timeRanges: { showCurrentTimeLine: false, enableResizing: false, showHeaderElements: true },
      calendarHighlight: {
        calendar: "resource",
        // while a bar is in the air, only the members who can really take the visit light up
        collectAvailableResources: ({ scheduler: s, eventRecords }: { scheduler: Scheduler; eventRecords: EventModel[] }) => {
          const g = verdicts(visitIdOf(eventRecords[0]!));
          return s.resourceStore.query((r) => g[String(r.id)]?.ok === true);
        },
      },
      eventDrag: {
        constrainDragToTimeSlot: true,
        validatorFn: ({ eventRecords, newResource }: { eventRecords: EventModel[]; newResource: ResourceModel }) => {
          const visitId = visitIdOf(eventRecords[0]!);
          const to = String(newResource.id);
          if (to === NEEDS_COVER) return { valid: false, message: "Release the hold from the visit's panel instead" };
          if (now().board.visits.find((x) => x.id === visitId)?.memberIds.includes(to)) return { valid: true, message: "" };
          const g = verdicts(visitId)[to];
          if (!g) return { valid: false, message: "Checking…" };
          if (!g.ok) return { valid: false, message: `${memberName(to)}: ${g.reasons.join("; ")}` };
          return { valid: true, message: g.consent ? `${memberName(to)} fits. The household asked for the same cleaner, so they are asked first.` : `${memberName(to)} fits. The hold stays with the visit.` };
        },
      },
      eventTooltip: {
        hoverDelay: 250,
        template: ({ eventRecord }: { eventRecord: EventModel }) => visitTip(eventRecord, now().board),
      },

      // ---- what this board does not do: a visit's time is in the agreement, and money decides what can move
      eventEdit: false,
      taskEdit: false,
      eventDragCreate: false,
      eventResize: false,
      eventMenu: false,
      scheduleMenu: false,
      cellMenu: false,
      headerMenu: false,
      timeAxisHeaderMenu: false,
      dependencies: false,
      dependencyMenu: false,
      cellEdit: false,
      eventCopyPaste: false,
      rowCopyPaste: false,
      columnPicker: false,
      columnReorder: false,
      group: false,
      sort: false,
      stickyEvents: false,
    } as never,

    listeners: {
      eventClick: ({ eventRecord }: { eventRecord: EventModel }) => now().onSelect(visitIdOf(eventRecord)),
      eventKeyDown: ({ eventRecords, event }: { eventRecords: EventModel[]; event: KeyboardEvent }) => {
        if ((event.key === "Enter" || event.key === " ") && eventRecords[0]) now().onSelect(visitIdOf(eventRecords[0]));
      },
      beforeEventDrag: ({ eventRecord }: { eventRecord: EventModel }) => eventRecord.get("kind") === "visit" && eventRecord.get("draggable") !== false,
      // the server has the last word: it checks again, then moves the visit or refuses
      beforeEventDropFinalize: ({ context }: { context: { async: boolean; finalize: (ok: boolean) => void; eventRecord: EventModel; newResource: ResourceModel; resourceRecord?: ResourceModel } }) => {
        const to = String(context.newResource.id);
        if (to === String(context.resourceRecord?.id ?? "")) return;
        context.async = true;
        void (async () => {
          try {
            const r = await api<{ pendingConsent: boolean }>(`/api/visits/${visitIdOf(context.eventRecord)}/move`, { memberId: to });
            context.finalize(!r.pendingConsent);
            now().onMoved(r.pendingConsent ? `${memberName(to)} is proposed, and the household is asked first. The hold stays with the visit.` : `Moved to ${memberName(to)}. The hold stays with the visit.`);
          } catch (e) {
            context.finalize(false);
            now().onRefused((e as Error).message);
          }
        })();
      },
    } as never,
  };
}

function memberCell(record: ResourceModel, board: Board, view: BoardView) {
  const id = String(record.id);
  if (id === NEEDS_COVER) {
    const n = board.visits.filter((v) => v.memberIds.length === 0 && !["cancelled", "late_cancel", "voided"].includes(v.state)).length;
    return { className: "member-cell uncovered", children: [{ tag: "b", text: "Needs cover" }, { tag: "small", text: `${n} visit${n === 1 ? "" : "s"}` }] };
  }
  const m = board.members.find((x) => x.id === id);
  if (!m) return record.name;
  const day = view.mode === "day" ? view.day : Math.floor(board.now / 1440);
  const out = board.disruptions.some((d) => d.memberId === id && d.status !== "dismissed" && d.affected.length > 0 && d.day === day);
  const works = m.availability.find((w) => w.day === day);
  const hours = m.bookedMinutes / 60;
  const pct = Math.min(100, Math.round((hours / m.weeklyHoursCap) * 100));
  return {
    className: `member-cell${out ? " is-out" : ""}`,
    dataset: { member: id },
    children: [
      { tag: "b", text: m.name },
      { tag: "small", text: out ? "out today" : works ? `${clock(works.from)}–${clock(works.to)} · ${m.languages.join(", ")}` : `not working · ${m.languages.join(", ")}` },
      {
        className: "hours",
        children: [
          { className: "hours-track", children: [{ className: `hours-fill${pct >= 100 ? " full" : ""}`, style: { width: `${pct}%` } }] },
          { tag: "small", text: `${hours.toFixed(1)}/${m.weeklyHoursCap} h` },
        ],
      },
    ],
  };
}

function visitTip(e: EventModel, board: Board) {
  const v = board.visits.find((x) => x.id === visitIdOf(e));
  const h = v && board.households.find((x) => x.id === v.householdId);
  if (!v || !h) return e.name ?? "";
  const needs = [...h.needs.map((n) => (n === "pets" ? "pets" : n === "eco" ? "fragrance-free" : "deep clean")), h.sameCleaner ? "same cleaner" : ""].filter(Boolean).join(", ");
  return {
    className: "visit-tip",
    children: [
      { tag: "b", text: h.name },
      { tag: "span", text: `${clock(v.start)}–${clock(v.start + v.minutes)} · ${h.area}` },
      { tag: "span", text: `${STATE_LABEL[v.state]}: ${e.get("chip") as string}` },
      needs ? { tag: "span", text: `Needs: ${needs}` } : null,
      v.hold ? { tag: "span", className: "mono", text: `PayPal authorization ${v.hold.authorizationId}` } : null,
    ],
  };
}
