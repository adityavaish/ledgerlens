/**
 * Pivot — Excel Operations Layer.
 * All Excel mutations go through here. The AI engine calls these methods
 * after interpreting the user's command.
 */

/* global Excel */

// ── Number-format presets ──────────────────────────────────────────────
// Lets the model say {numberFormatPreset: "date_medium"} instead of
// memorising raw Excel format strings. Custom strings via numberFormat win.
const NUMBER_FORMAT_PRESETS = {
  // Dates
  date_short:        "m/d/yyyy",
  date_medium:       "mmm d, yyyy",          // Jan 1, 2026
  date_long:         "mmmm d, yyyy",         // January 1, 2026
  date_iso:          "yyyy-mm-dd",
  date_us:           "mm/dd/yyyy",
  date_eu:           "dd/mm/yyyy",
  month_year:        "mmm yyyy",
  // Times / datetime
  time:              "h:mm AM/PM",
  time_24h:          "hh:mm",
  datetime_medium:   "mmm d, yyyy h:mm AM/PM",
  // Numbers
  integer:           "#,##0",
  number_2:          "#,##0.00",
  percent:           "0%",
  percent_2:         "0.00%",
  // Currency (USD default; for other ISO codes pass numberFormat directly)
  usd:               "$#,##0.00;[Red]-$#,##0.00",
  usd_whole:         "$#,##0;[Red]-$#,##0",
  accounting_usd:    "_($* #,##0.00_);_($* (#,##0.00);_($* \"-\"??_);_(@_)",
  // Other
  scientific:        "0.00E+00",
  text:              "@",
};

function _resolveNumberFormat(preset) {
  if (!preset) return null;
  return NUMBER_FORMAT_PRESETS[preset] || null;
}

class ExcelOps {
  // ── Data ──────────────────────────────────────────────────────────────

  async writeData(startCell, headers, rows) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const totalRows = rows.length + (headers ? 1 : 0);
      const totalCols = headers ? headers.length : rows[0]?.length || 0;
      const range = sheet.getRange(startCell).getResizedRange(totalRows - 1, totalCols - 1);
      const values = headers ? [headers, ...rows] : rows;
      range.values = values;
      range.format.autofitColumns();
      await ctx.sync();
    });
  }

  async updateRange(rangeAddr, values) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(rangeAddr);
      range.values = values;
      await ctx.sync();
    });
  }

  async clearRange(rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(rangeAddr).clear();
      await ctx.sync();
    });
  }

  // ── Tables ────────────────────────────────────────────────────────────

  async createTable(rangeAddr, name, hasHeaders = true) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const table = sheet.tables.add(rangeAddr, hasHeaders);
      if (name) table.name = name;
      table.style = "TableStyleMedium2";
      sheet.getRange(rangeAddr).format.autofitColumns();
      await ctx.sync();
    });
  }

  async updateTable(name, updates) {
    await Excel.run(async (ctx) => {
      const table = ctx.workbook.tables.getItem(name);
      if (updates.name) table.name = updates.name;
      if (updates.style) table.style = updates.style;
      await ctx.sync();
    });
  }

  // ── Charts ────────────────────────────────────────────────────────────

  async createChart(type, dataRange, title) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const chartType = this._mapChartType(type);
      // Office.js getRange() doesn't support comma-separated ranges
      // Use getRanges() for non-contiguous ranges, or fall back to contiguous
      let range;
      if (dataRange && dataRange.includes(",")) {
        try {
          range = sheet.getRanges(dataRange);
        } catch {
          // If getRanges fails, use the first part only
          range = sheet.getRange(dataRange.split(",")[0].trim());
        }
      } else {
        range = sheet.getRange(dataRange);
      }
      const chart = sheet.charts.add(chartType, range, Excel.ChartSeriesBy.auto);
      chart.title.text = title || "";
      chart.setPosition("F2");
      chart.width = 450;
      chart.height = 300;
      await ctx.sync();
    });
  }

  async updateChart(name, updates) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const chart = sheet.charts.getItem(name);
      if (updates.title) chart.title.text = updates.title;
      if (updates.type) chart.chartType = this._mapChartType(updates.type);
      if (updates.width) chart.width = updates.width;
      if (updates.height) chart.height = updates.height;
      await ctx.sync();
    });
  }

  _mapChartType(type) {
    const map = {
      bar: Excel.ChartType.barClustered,
      column: Excel.ChartType.columnClustered,
      line: Excel.ChartType.line,
      pie: Excel.ChartType.pie,
      scatter: Excel.ChartType.xyscatter,
      area: Excel.ChartType.area,
      doughnut: Excel.ChartType.doughnut,
      radar: Excel.ChartType.radar,
    };
    return map[type?.toLowerCase()] || Excel.ChartType.columnClustered;
  }

  // ── Pivot Tables ──────────────────────────────────────────────────────

  async createPivot(sourceRange, rows, columns, values) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const pivotSheet = ctx.workbook.worksheets.add("PivotTable");
      const rangeObj = sheet.getRange(sourceRange);
      const pivot = pivotSheet.pivotTables.add("PivotTable1", rangeObj, "A1");

      rows?.forEach((r) => pivot.rowHierarchies.add(pivot.hierarchies.getItem(r)));
      columns?.forEach((c) => pivot.columnHierarchies.add(pivot.hierarchies.getItem(c)));
      values?.forEach((v) => pivot.dataHierarchies.add(pivot.hierarchies.getItem(v)));

      pivotSheet.activate();
      await ctx.sync();
    });
  }

  // ── Formatting ────────────────────────────────────────────────────────

  async formatRange(rangeAddr, fmt) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(rangeAddr);
      if (fmt.bold !== undefined) range.format.font.bold = fmt.bold;
      if (fmt.italic !== undefined) range.format.font.italic = fmt.italic;
      if (fmt.underline !== undefined) range.format.font.underline = fmt.underline ? "Single" : "None";
      if (fmt.fontSize) range.format.font.size = fmt.fontSize;
      if (fmt.fontColor) range.format.font.color = fmt.fontColor;
      if (fmt.fontName) range.format.font.name = fmt.fontName;
      if (fmt.fill) range.format.fill.color = fmt.fill;
      if (fmt.horizontalAlignment) range.format.horizontalAlignment = fmt.horizontalAlignment;
      if (fmt.verticalAlignment) range.format.verticalAlignment = fmt.verticalAlignment;
      if (fmt.wrapText !== undefined) range.format.wrapText = fmt.wrapText;
      if (fmt.indentLevel !== undefined) range.format.indentLevel = fmt.indentLevel;
      if (fmt.columnWidth) range.format.columnWidth = fmt.columnWidth;
      if (fmt.rowHeight) range.format.rowHeight = fmt.rowHeight;
      if (fmt.borders) {
        const border = range.format.borders;
        const style = Excel.BorderLineStyle.continuous;
        const sides = ["EdgeTop", "EdgeBottom", "EdgeLeft", "EdgeRight", "InsideHorizontal", "InsideVertical"];
        for (const s of sides) border.getItem(s).style = style;
      }

      // numberFormat / numberFormatLocal require a 2D array sized to the range.
      const numberFormat = fmt.numberFormat || _resolveNumberFormat(fmt.numberFormatPreset);
      if (numberFormat) {
        range.load(["rowCount", "columnCount"]);
        await ctx.sync();
        const tiled = Array.from({ length: range.rowCount }, () =>
          Array.from({ length: range.columnCount }, () => numberFormat)
        );
        range.numberFormat = tiled;
      }

      if (fmt.autofitColumns !== false) range.format.autofitColumns();
      if (fmt.autofitRows) range.format.autofitRows();
      await ctx.sync();
    });
  }

  async formatColumns(columns, fmt) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const cols = (Array.isArray(columns) ? columns : [columns]).filter(Boolean);
      for (const col of cols) {
        const addr = `${col}:${col}`;
        const range = sheet.getRange(addr);
        if (fmt.bold !== undefined) range.format.font.bold = fmt.bold;
        if (fmt.italic !== undefined) range.format.font.italic = fmt.italic;
        if (fmt.fontSize) range.format.font.size = fmt.fontSize;
        if (fmt.fontColor) range.format.font.color = fmt.fontColor;
        if (fmt.fill) range.format.fill.color = fmt.fill;
        if (fmt.horizontalAlignment) range.format.horizontalAlignment = fmt.horizontalAlignment;
        if (fmt.columnWidth) range.format.columnWidth = fmt.columnWidth;

        const numberFormat = fmt.numberFormat || _resolveNumberFormat(fmt.numberFormatPreset);
        if (numberFormat) {
          // Apply to the used portion of the column to avoid touching all 1M+ rows
          const used = sheet.getUsedRange(true);
          used.load(["rowCount", "rowIndex"]);
          await ctx.sync();
          const startRow = (used.rowIndex || 0) + 1;
          const endRow = startRow + (used.rowCount || 1) - 1;
          const colRange = sheet.getRange(`${col}${startRow}:${col}${endRow}`);
          colRange.load(["rowCount", "columnCount"]);
          await ctx.sync();
          const tiled = Array.from({ length: colRange.rowCount }, () =>
            Array.from({ length: colRange.columnCount }, () => numberFormat)
          );
          colRange.numberFormat = tiled;
        }
        if (fmt.autofitColumns !== false) range.format.autofitColumns();
      }
      await ctx.sync();
    });
  }

  // ── Conditional Formatting ────────────────────────────────────────────

  async conditionalFormat(rangeAddr, rule, values, format) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(rangeAddr);

      if (rule === "colorScale") {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.colorScale);
        cf.colorScale.criteria = {
          minimum: { color: "#F8696B", type: "LowestValue" },
          midpoint: { color: "#FFEB84", type: "Percentile", value: 50 },
          maximum: { color: "#63BE7B", type: "HighestValue" },
        };
      } else if (rule === "dataBar") {
        range.conditionalFormats.add(Excel.ConditionalFormatType.dataBar);
      } else if (rule === "iconSet") {
        range.conditionalFormats.add(Excel.ConditionalFormatType.iconSet);
      } else {
        // Cell-value based rules
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.cellValue);
        const operatorMap = {
          greaterThan: "GreaterThan",
          lessThan: "LessThan",
          between: "Between",
          equalTo: "EqualTo",
        };
        cf.cellValue.rule = {
          operator: operatorMap[rule] || "GreaterThan",
          formula1: String(values?.[0] ?? 0),
          formula2: values?.[1] !== undefined ? String(values[1]) : undefined,
        };
        if (format.fill) cf.cellValue.format.fill.color = format.fill;
        if (format.fontColor) cf.cellValue.format.font.color = format.fontColor;
      }

      await ctx.sync();
    });
  }

  // ── Formulas ──────────────────────────────────────────────────────────

  async insertFormula(cell, formula) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(cell).formulas = [[formula]];
      await ctx.sync();
    });
  }

  async fillFormulas(startCell, formula, fillDown) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(startCell).getResizedRange(fillDown - 1, 0);
      const formulas = [];
      for (let i = 0; i < fillDown; i++) formulas.push([formula]);
      range.formulas = formulas;
      await ctx.sync();
    });
  }

  // ── Sorting & Filtering ───────────────────────────────────────────────

  async sortRange(rangeAddr, columnIndex, ascending = true) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(rangeAddr);
      range.sort.apply([{ key: columnIndex, ascending }]);
      await ctx.sync();
    });
  }

  async filterRange(rangeAddr, columnIndex, criteria) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(rangeAddr).autoFilter.apply(columnIndex, { criterion1: criteria });
      await ctx.sync();
    });
  }

  async clearFilters(rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      if (rangeAddr) {
        sheet.getRange(rangeAddr).autoFilter.clearCriteria();
      } else {
        sheet.autoFilter.clearCriteria();
      }
      await ctx.sync();
    });
  }

  // ── Merge / Unmerge ───────────────────────────────────────────────────

  async mergeCells(rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(rangeAddr).merge();
      await ctx.sync();
    });
  }

  async unmergeCells(rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(rangeAddr).unmerge();
      await ctx.sync();
    });
  }

  // ── Sheets ────────────────────────────────────────────────────────────

  async addSheet(name) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.add(name);
      sheet.activate();
      await ctx.sync();
    });
  }

  async renameSheet(oldName, newName) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getItem(oldName);
      sheet.name = newName;
      await ctx.sync();
    });
  }

  async deleteSheet(name) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getItem(name);
      sheet.delete();
      await ctx.sync();
    });
  }

  async deleteRange(rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(rangeAddr).delete(Excel.DeleteShiftDirection.up);
      await ctx.sync();
    });
  }

  // ── Freeze Panes ─────────────────────────────────────────────────────

  async freezePanes(row, column) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.freezePanes.unfreeze();
      if (row > 0 && column > 0) {
        const cell = sheet.getCell(row, column);
        sheet.freezePanes.freezeAt(cell);
      } else if (row > 0) {
        sheet.freezePanes.freezeRows(row);
      } else if (column > 0) {
        sheet.freezePanes.freezeColumns(column);
      }
      await ctx.sync();
    });
  }

  // ── Named Ranges ─────────────────────────────────────────────────────

  async nameRange(rangeAddr, name) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      ctx.workbook.names.add(name, sheet.getRange(rangeAddr));
      await ctx.sync();
    });
  }

  // ── Sheet Protection ─────────────────────────────────────────────────

  async protectSheet(password) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.protection.protect({ allowAutoFilter: true, allowSort: true }, password || undefined);
      await ctx.sync();
    });
  }

  // ── Auto Fit ─────────────────────────────────────────────────────────

  async autoFit(rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = rangeAddr ? sheet.getRange(rangeAddr) : sheet.getUsedRange();
      range.format.autofitColumns();
      range.format.autofitRows();
      await ctx.sync();
    });
  }

  // ── Find & Replace ───────────────────────────────────────────────────

  async findReplace(find, replace, rangeAddr) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = rangeAddr ? sheet.getRange(rangeAddr) : sheet.getUsedRange();
      range.load("values");
      await ctx.sync();

      const values = range.values;
      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < values[r].length; c++) {
          if (typeof values[r][c] === "string" && values[r][c].includes(find)) {
            values[r][c] = values[r][c].split(find).join(replace);
          }
        }
      }
      range.values = values;
      await ctx.sync();
    });
  }

  // ── Data Validation ──────────────────────────────────────────────────

  async validateData(rangeAddr, type, values) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = sheet.getRange(rangeAddr);

      if (type === "list") {
        range.dataValidation.rule = {
          list: { inCellDropDown: true, source: values.join(",") },
        };
      } else if (type === "number") {
        range.dataValidation.rule = {
          wholeNumber: {
            formula1: values?.[0] ?? 0,
            formula2: values?.[1] ?? 100,
            operator: "Between",
          },
        };
      } else if (type === "date") {
        range.dataValidation.rule = {
          date: {
            formula1: values?.[0] || "2020-01-01",
            formula2: values?.[1] || "2030-12-31",
            operator: "Between",
          },
        };
      }

      range.dataValidation.errorAlert = {
        showAlert: true,
        title: "Invalid Input",
        message: `Please enter a valid ${type} value.`,
      };
      await ctx.sync();
    });
  }

  // ── Column / Row Visibility ──────────────────────────────────────────

  async hideColumns(columns) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      for (const col of columns) {
        const range = sheet.getRange(`${col}:${col}`);
        range.columnHidden = true;
      }
      await ctx.sync();
    });
  }

  async showColumns(columns) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      for (const col of columns) {
        const range = sheet.getRange(`${col}:${col}`);
        range.columnHidden = false;
      }
      await ctx.sync();
    });
  }

  async hideRows(rows) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      for (const row of rows) {
        const range = sheet.getRange(`${row}:${row}`);
        range.rowHidden = true;
      }
      await ctx.sync();
    });
  }

  async showRows(rows) {
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      for (const row of rows) {
        const range = sheet.getRange(`${row}:${row}`);
        range.rowHidden = false;
      }
      await ctx.sync();
    });
  }

  // ── Context helpers (used to gather context for AI) ───────────────────

  async getContext() {
    let context = {};
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.load("name");
      const sel = ctx.workbook.getSelectedRange();
      sel.load(["address", "values", "rowCount", "columnCount"]);

      // Get nearby data — the used range
      const used = sheet.getUsedRangeOrNullObject();
      used.load(["address", "values", "rowCount", "columnCount"]);

      await ctx.sync();

      context.sheetName = sheet.name;
      context.selectedRange = sel.address;

      let nearbyData = [];
      if (!used.isNullObject && used.rowCount <= 100 && used.columnCount <= 26) {
        nearbyData = used.values;
      } else if (!used.isNullObject) {
        // Too large — sample first 20 rows
        nearbyData = used.values?.slice(0, 20) || [];
      }
      context.nearbyData = nearbyData;
    });
    return context;
  }
}

const excelOps = new ExcelOps();
export default excelOps;
