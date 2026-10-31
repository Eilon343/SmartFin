/**
 * The wall-clock fields `timeZone` shows at a given instant.
 *
 * The containers run on UTC (nothing sets TZ), so local time cannot be read off a Date
 * directly — Intl is what knows about Israel's DST, which is what makes 07:00 mean 07:00
 * in both winter and summer rather than sliding an hour twice a year.
 */
function zonedParts(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
    const at = (type) => Number(parts.find((p) => p.type === type).value);
    return {
        year: at('year'), month: at('month'), day: at('day'),
        hour: at('hour'), minute: at('minute'), second: at('second'),
    };
}

/** How far ahead of UTC `timeZone` runs at `instant`, in ms. */
function zoneOffsetMs(instant, timeZone) {
    const p = zonedParts(instant, timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    // zonedParts has second resolution, so the comparison must too.
    return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which `timeZone`'s clock reads the given local date at `hour`:00. */
function instantAtLocalHour({ year, month, day }, hour, timeZone) {
    const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
    // The offset depends on the instant, and the instant on the offset. One correction
    // pass settles it everywhere except inside a DST transition itself.
    const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
    return new Date(naive - zoneOffsetMs(new Date(firstPass), timeZone));
}

module.exports = { zonedParts, instantAtLocalHour };
