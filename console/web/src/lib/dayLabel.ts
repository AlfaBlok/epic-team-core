// the day and slot words on their own, so the Inbox reads them without the social pages' parts (re-exported there).
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon 19 Oct", the same in every locale. */
export const dayLabel = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
/** "Mon 19 Oct 10:00" for a slot, else the day. */
export const slotLabel = (p: { slot?: string; date: string }) => (p.slot ? `${dayLabel(p.slot)}${p.slot.length > 10 ? ` ${p.slot.slice(11, 16)}` : ""}` : dayLabel(p.date));
