import { BEGIN, CALENDAR_CONFIG } from './config';

export class CalendarComponent {
    constructor() {
        this.width = CALENDAR_CONFIG.width;
        this.cellSize = CALENDAR_CONFIG.cellSize;
        this.height = CALENDAR_CONFIG.height;
    }

    createCalendar(data) {
        const formatDate = d3.utcFormat("%x");
        const formatDay = i => "SMTWTFS"[i];
        const formatMonth = d3.utcFormat("%b");
        const timeWeek = d3.utcSunday;
        const countDay = i => i;

        // Process data for calendar view
        const sessions = new Map(d3.group(data, d => d3.timeDay(d.timestamp).getTime()));
        const v = d => sessions.has(d.getTime()) ? sessions.get(d.getTime()).length : 0;
        const days = d3.timeDay.range(BEGIN, new Date()).map(d => ({date: d, value: v(d)}));
        const values = d3.sort(Array.from(sessions.values()).map(v => v.length));

        // Color scale for calendar
        const color = d3.scaleSequential(d3.interpolateGreens).domain([0, 10]);

        // Group by year
        const years = d3.groups(days, d => d.date.getUTCFullYear()).reverse();

        // Create legend
        this.createLegend({
            color,
            title: "# Quartets Played",
            marginLeft: 40.5,
            tickFormat: i => (i == 10) ? "10+" : d3.format("d")(i)
        });

        // Create calendar SVG
        const svg = d3.select("#calendar").append("svg")
            .attr("width", this.width)
            .attr("height", this.height * years.length)
            .attr("viewBox", [0, 0, this.width, this.height * years.length])
            .attr("style", "max-width: 100%; height: auto; font: 10px sans-serif;");

        this.renderYearGroups(svg, years, {
            timeWeek,
            formatDay,
            formatMonth,
            formatDate,
            countDay,
            color,
            sessions
        });
    }

    renderYearGroups(svg, years, config) {
        const { timeWeek, formatDay, formatMonth, formatDate, countDay, color, sessions } = config;

        const year = svg.selectAll("g")
            .data(years)
            .join("g")
            .attr("transform", (d, i) => `translate(40.5,${this.height * i + this.cellSize * 1.5})`);

        // Year label
        year.append("text")
            .attr("x", -5)
            .attr("y", -5)
            .attr("font-weight", "bold")
            .attr("text-anchor", "end")
            .text(([key]) => key);

        // Day of week labels
        year.append("g")
            .attr("text-anchor", "end")
            .selectAll()
            .data(d3.range(7))
            .join("text")
            .attr("x", -5)
            .attr("y", i => (countDay(i) + 0.5) * this.cellSize)
            .attr("dy", "0.31em")
            .text(formatDay);

        // Calendar cells
        this.renderCalendarCells(year, timeWeek, countDay, color, formatDate);

        // Add month paths and labels
        this.renderMonthLabels(year, timeWeek, formatMonth);
    }

    renderCalendarCells(year, timeWeek, countDay, color, formatDate) {
        year.append("g")
            .selectAll()
            .data(([, values]) => values)
            .join("rect")
            .attr("width", this.cellSize - 1)
            .attr("height", this.cellSize - 1)
            .attr("x", d => timeWeek.count(d3.utcYear(d.date), d.date) * this.cellSize + 0.5)
            .attr("y", d => countDay(d.date.getUTCDay()) * this.cellSize + 0.5)
            .attr("fill", d => d.value == 0 ? "#eee" : color(d.value))
            .append("title")
            .text(d => `${formatDate(d.date)}: ${d.value}`);
    }

    renderMonthLabels(year, timeWeek, formatMonth) {
        const month = year.append("g")
            .selectAll()
            .data(([, values]) => d3.utcMonths(d3.utcMonth(values[0].date), values.at(-1).date))
            .join("g");

        month.filter((d, i) => i).append("path")
            .attr("fill", "none")
            .attr("stroke", "#fff")
            .attr("stroke-width", 3)
            .attr("d", this.pathMonth.bind(this));

        month.append("text")
            .attr("x", d => timeWeek.count(d3.utcYear(d), timeWeek.ceil(d)) * this.cellSize + 2)
            .attr("y", -5)
            .text(formatMonth);
    }

    pathMonth(t) {
        const d = t.getUTCDay();
        const w = d3.utcSunday.count(d3.utcYear(t), t);
        return `${d === 0 ? `M${w * this.cellSize},0`
            : `M${(w + 1) * this.cellSize},0V${d * this.cellSize}H${w * this.cellSize}`}V${7 * this.cellSize}`;
    }

    // https://stackoverflow.com/questions/64803258/¬
    createLegend({
        color,
        title,
        tickSize = 6,
        width = 320,
        height = 44 + tickSize,
        marginTop = 18,
        marginRight = 0,
        marginBottom = 16 + tickSize,
        marginLeft = 0,
        ticks = width / 64,
        tickFormat,
        tickValues
    } = {}) {
        const svg = d3.select("#calendar").append("svg")
            .attr("width", width)
            .attr("height", height)
            .attr("viewBox", [0, 0, width, height])
            .style("overflow", "visible")
            .style("display", "block");

        let x;

        if (color.interpolator) {
            x = Object.assign(
                color.copy().interpolator(d3.interpolateRound(marginLeft, width - marginRight)),
                { range() { return [marginLeft, width - marginRight]; }}
            );

            svg.append("image")
                .attr("x", marginLeft)
                .attr("y", marginTop)
                .attr("width", width - marginLeft - marginRight)
                .attr("height", height - marginTop - marginBottom)
                .attr("preserveAspectRatio", "none")
                .attr("xlink:href", this.ramp(color.interpolator()).toDataURL());

            if (!x.ticks) {
                if (tickValues === undefined) {
                    const n = Math.round(ticks + 1);
                    tickValues = d3.range(n).map(i => d3.quantile(color.domain(), i / (n - 1)));
                }
                if (typeof tickFormat !== "function") {
                    tickFormat = d3.format(tickFormat === undefined ? ",f" : tickFormat);
                }
            }
        }

        svg.append("g")
            .attr("transform", `translate(0,${height - marginBottom})`)
            .call(d3.axisBottom(x)
                .ticks(ticks, typeof tickFormat === "string" ? tickFormat : undefined)
                .tickFormat(typeof tickFormat === "function" ? tickFormat : undefined)
                .tickSize(tickSize)
                .tickValues(tickValues))
            .call(g => g.select(".domain").remove())
            .call(g => g.append("text")
                .attr("x", marginLeft)
                .attr("y", marginTop + marginBottom - height - 6)
                .attr("fill", "currentColor")
                .attr("text-anchor", "start")
                .attr("font-weight", "bold")
                .text(title));
    }

    ramp(color, n = 256) {
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        for (let i = 0; i < n; ++i) {
            context.fillStyle = color(i / (n - 1));
            context.fillRect(i, 0, 1, 1);
        }
        return canvas;
    }
}
