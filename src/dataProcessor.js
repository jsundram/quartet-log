import { PLAYER_ABBREVIATIONS } from './config';

export function parseWork(title) {
    // Incompletely played works are usually noted like e.g. 17#2:I.
    let incomplete = title.indexOf(":") != -1;

    const pound = title.indexOf('#');
    const number = pound == -1 ? null : parseInt(title.substr(pound + 1));
    let catalog = null;

    if (number === null)
        catalog = parseInt(title);
    else {
        catalog = parseInt(title.substr(0, pound));
    }
    if (isNaN(catalog)) {
        catalog = parseInt(title.substr(1));
    }

    return {
        "title": title,
        "incomplete": incomplete,
        "catalog": catalog,
        "number": number
    };
}

export function processRow(d) {
    return {
        "timestamp": new Date(d.Timestamp),
        "composer": d.Composer.trim(),
        "work": parseWork(d["Work Title"].trim()),
        "part": d["Which Part"] == "VA1" ? "VA" : d["Which Part"],
        "player1": d["Player 1"].trim(),
        "player2": d["Player 2"].trim(),
        "player3": d["Player 3"].trim(),
        "others": d["Others?"].trim(),
        "location": d.Location.trim(),
        "comments": d.Comments.trim()
    };
}

export function fillForward(data) {
    ["player1", "player2", "player3", "location"].forEach(column => {
        let prev = data[0];
        let prevEntry = prev[column];

        data.slice(1).forEach(row => {
            const entry = row[column].trim();
            if (entry != '-') {
                const hours = (row.timestamp - prev.timestamp) / 1000 / 60 / 60;
                if (hours < 4 && prevEntry.indexOf(entry) != -1) {
                    row[column] = prevEntry;
                } else if (PLAYER_ABBREVIATIONS.hasOwnProperty(entry)) {
                    prevEntry = PLAYER_ABBREVIATIONS[entry];
                    row[column] = prevEntry;
                } else {
                    prevEntry = entry;
                }
                prev = row;
            }
        });
    });
    return data;
}

export function createEmptyRow(composer, title) {
    return {
        "timestamp": null,
        "composer": composer,
        "work": parseWork(title),
        "part": null,
        "player1": null,
        "player2": null,
        "player3": null,
        "others": null,
        "location": null,
        "comments": ""
    };
}
