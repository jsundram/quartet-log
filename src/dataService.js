import { DATA_URL } from './config';
import { ALL_WORKS} from './catalog';
import { processRow, fillForward } from './dataProcessor';

export class DataService {
    constructor() {
        this.data = null;
    }

    async fetchCSV(url) {
        const cachedData = localStorage.getItem(DATA_URL);
        const cachedTimestamp = localStorage.getItem(`${DATA_URL}_timestamp`);
        const timeoutDuration = 5000;

        return new Promise((resolve, reject) => {
            const useCached = () => {
                if (cachedData) {
                    console.log(`Using cached data from ${new Date(parseInt(cachedTimestamp))}`);
                    let parsed = JSON.parse(cachedData);
                    parsed.forEach(d => d.timestamp = new Date(d.timestamp));
                    resolve({
                        parsed,
                        timestamp: parseInt(cachedTimestamp),
                        source: 'cache'
                    });
                } else {
                    reject(new Error('No cached data available'));
                }
            };

            const timeoutId = setTimeout(useCached, timeoutDuration);

            d3.csv(DATA_URL, processRow)
                .then(d => {
                    clearTimeout(timeoutId);
                    const timestamp = Date.now();
                    localStorage.setItem(DATA_URL, JSON.stringify(d));
                    localStorage.setItem(`${DATA_URL}_timestamp`, timestamp.toString());
                    resolve({
                        parsed: d,
                        timestamp,
                        source: 'fresh'
                    });
                })
                .catch(error => {
                    clearTimeout(timeoutId);
                    useCached();
                });
        });
    }

    processData(rawData) {
        if (!ALL_WORKS) {
            throw new Error('Work catalog not initialized');
        }

        let processedData = fillForward(rawData);

        // Filter out skipped works and works not in catalog
        processedData = processedData.filter(d => !d.work.skip);
        processedData = processedData.filter(d =>
            !ALL_WORKS.hasOwnProperty(d.composer) ||
            ALL_WORKS[d.composer].includes(d.work.title)
        );

        return processedData;
    }

    formatTimeSince(previous) {
        const current = Date.now();
        const msPerMinute = 60 * 1000;
        const msPerHour = msPerMinute * 60;
        const msPerDay = msPerHour * 24;
        const msPerMonth = msPerDay * 30;
        const msPerYear = msPerDay * 365;
        const elapsed = current - previous;

        if (elapsed < msPerMinute) {
            return 'a few seconds ago';
        } else if (elapsed < msPerHour) {
            return Math.round(elapsed / msPerMinute) + ' minutes ago';
        } else if (elapsed < msPerDay) {
            return Math.round(elapsed / msPerHour) + ' hours ago';
        } else if (elapsed < msPerMonth) {
            return Math.round(elapsed / msPerDay) + ' days ago';
        } else if (elapsed < msPerYear) {
            return Math.round(elapsed / msPerMonth) + ' months ago';
        } else {
            return Math.round(elapsed / msPerYear) + ' years ago';
        }
    }
}
