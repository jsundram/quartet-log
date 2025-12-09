export class TableComponent {
    constructor() {
        this.allColumns = [
            { key: 'timestamp', label: 'Date', format: d => d.toLocaleDateString() },
            { key: 'composer', label: 'Composer', format: d => d },
            { key: 'work.title', label: 'Work', format: d => d },
            { key: 'part', label: 'Part', format: d => d },
            { key: 'player1', label: 'Player 1', format: d => d },
            { key: 'player2', label: 'Player 2', format: d => d },
            { key: 'player3', label: 'Player 3', format: d => d },
            { key: 'location', label: 'Location', format: d => d },
            { key: 'comments', label: 'Comments', format: d => d }
        ];
        // Track sort state per composer
        this.sortStates = new Map();
    }

    getColumnsForComposer(composer) {
        // For non-MISC tabs, exclude the composer column
        if (composer !== 'MISC') {
            return this.allColumns.filter(col => col.key !== 'composer');
        }
        return this.allColumns;
    }

    createTable(container, composer) {
        const columns = this.getColumnsForComposer(composer);

        const tableWrapper = d3.select(container)
            .append('div')
            .attr('class', 'table-wrapper')
            .attr('data-composer', composer)
            .style('overflow-x', 'auto')
            .style('margin-top', '20px');

        const table = tableWrapper
            .append('table')
            .attr('class', 'data-table')
            .style('width', '100%')
            .style('border-collapse', 'collapse');

        const thead = table.append('thead');
        const headerRow = thead.append('tr');

        headerRow.selectAll('th')
            .data(columns)
            .join('th')
            .style('cursor', 'pointer')
            .style('padding', '8px')
            .style('border', '1px solid #ddd')
            .style('background-color', '#f5f5f5')
            .text(d => d.label)
            .on('click', (event, d) => {
                const composer = d3.select(event.target.closest('.table-wrapper')).attr('data-composer');
                this.updateSort(composer, d.key);

                // Get data and update
                const data = d3.select(event.target.closest('.table-container')).datum();
                const container = d3.select(event.target.closest('.table-container'));
                this.updateTable(data, container);
            });

        table.append('tbody');
    }

    updateSort(composer, columnKey) {
        let state = this.sortStates.get(composer);
        if (!state) {
            state = { key: 'timestamp', direction: 'desc' };
            this.sortStates.set(composer, state);
        }

        if (state.key === columnKey) {
            state.direction = state.direction === 'asc' ? 'desc' : 'asc';
        } else {
            state.key = columnKey;
            state.direction = 'asc';
        }
    }

    getValue(obj, path) {
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    }

    updateTable(composerData, tableContainer) {
        const composer = tableContainer.select('.table-wrapper').attr('data-composer');
        const columns = this.getColumnsForComposer(composer);
        const sortState = this.sortStates.get(composer) || { key: 'timestamp', direction: 'desc' };

        // Convert map to array of play records
        const flatData = Array.from(composerData.filteredPlays.entries())
            .flatMap(([title, plays]) => plays);

        // Sort data
        const sortedData = [...flatData].sort((a, b) => {
            if (sortState.key === 'work.title') {
                // 'work.title' is a string, we want to sort by catalog (int) and then number (int or null)
                const aCatalog = this.getValue(a, 'work.catalog') || 0;
                const bCatalog = this.getValue(b, 'work.catalog') || 0;
                if (aCatalog !== bCatalog) {
                    return sortState.direction === 'asc' ? aCatalog - bCatalog : bCatalog - aCatalog;
                }

                const aNumber = this.getValue(a, 'work.number') || 0;
                const bNumber = this.getValue(b, 'work.number') || 0;
                return sortState.direction === 'asc' ? aNumber - bNumber : bNumber - aNumber;
            }
            else {
                const aValue = this.getValue(a, sortState.key);
                const bValue = this.getValue(b, sortState.key);

                const comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
                return sortState.direction === 'asc' ? comparison : -comparison;
            }
        });

        // Update rows
        const tbody = tableContainer.select('tbody');
        const rows = tbody.selectAll('tr')
            .data(sortedData)
            .join('tr')
            .style('border', '1px solid #ddd')
            .style('background-color', (d, i) => i % 2 === 0 ? '#fff' : '#f9f9f9');

        // Update cells
        rows.selectAll('td')
            .data(row => columns.map(column => ({
                value: this.getValue(row, column.key),
                format: column.format
            })))
            .join('td')
            .style('padding', '4px')
            .style('border', '1px solid #ddd')
            .text(d => d.format(d.value));

        // Update header arrows
        tableContainer.selectAll('th')
            .text(d => {
                const isCurrentSort = sortState.key === d.key;
                // &nbsp; => \u00A0 since we're using a template literal below
                return `${d.label}${isCurrentSort ? `\u00A0${sortState.direction === 'asc' ? '↓' : '↑'}` : ''}`;
            });
    }
}
