/*
* website-listing-template
.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/
import { format } from "datetime/mod.ts";
import { Document, Element } from "deno_dom/deno-dom-wasm-noinit.ts";
import { ld } from "lodash/mod.ts";

import { renderEjs } from "../../../../core/ejs.ts";
import { resourcePath } from "../../../../core/resources.ts";
import {
  kColumnCount,
  kColumnLinks,
  kColumns,
  kColumnSortTargets,
  kColumnTypes,
  kRowCount,
  Listing,
  ListingItem,
  ListingType,
} from "./website-listing-shared.ts";

export const kDateFormat = "date-format";
export const kMaxDescLength = "max-description-length";

export const kCardColumnSpan = "card-column-span";

// Create a markdown handler for the markdown pipeline
// This will render an EJS template into markdown
// (providing options and items to the template)
// make that markdown available to the pipeline,
// then insert the rendered HTML into the document
export function templateMarkdownHandler(
  template: string,
  listing: Listing,
  items: ListingItem[],
  attributes?: Record<string, string>,
) {
  // Process the items into simple key value pairs, applying
  // any formatting
  const reshapedItems: Record<string, unknown | undefined>[] = items.map(
    (item) => {
      resolveItemForTemplate(item, listing);

      const record: Record<string, unknown | undefined> = { ...item };
      // TODO: Improve author formatting
      record.author = item.author ? item.author.join(", ") : undefined;

      // Format date values
      // Read date formatting from an option, if present
      const dateFormat = listing[kDateFormat] as string;

      if (item.date) {
        record.date = dateFormat
          ? format(item.date, dateFormat)
          : item.date.toLocaleDateString();
      }
      if (item.filemodified) {
        record.filemodified = dateFormat
          ? format(item.filemodified, dateFormat)
          : item.filemodified.toLocaleString();
      }

      if (item.description !== undefined) {
        const maxDescLength = listing[kMaxDescLength] as number ||
          -1;
        if (maxDescLength > 0) {
          record.description = truncateText(item.description, maxDescLength);
        }
      }

      return record;
    },
  );

  // Render the template into markdown
  const markdown = renderEjs(
    resourcePath(template),
    {
      listing: reshapeListing(listing),
      items: reshapedItems,
    },
    false,
  );

  // Return the handler
  return {
    getUnrendered() {
      return {
        blocks: {
          [listing.id]: markdown,
        },
      };
    },
    processRendered(rendered: Record<string, Element>, doc: Document) {
      // See if there is a target div already in the page
      let listingEl = doc.getElementById(listing.id);
      if (listingEl === null) {
        // No target div, cook one up
        const content = doc.querySelector("#quarto-content main.content");
        if (content) {
          listingEl = doc.createElement("div");
          listingEl.setAttribute("id", listing.id);
          content.appendChild(listingEl);
        }
      }

      // Append any requested classes
      if (listing.classes) {
        listing.classes.forEach((clz) => listingEl?.classList.add(clz));
      }

      // Add attributes
      if (attributes) {
        Object.keys(attributes).forEach((attrName) => {
          listingEl?.setAttribute(attrName, attributes[attrName]);
        });
      }

      const renderedEl = rendered[listing.id];
      listingEl!.innerHTML = renderedEl.innerHTML;
    },
  };
}

// Items in templates need to carry additional information to assist
// rendering. For example, item fields that are non string types
// need to carry a sortable version of their value (e.g. a date needs
// a sortable version of the date)- this function will resolve item
// data into template ready versions of the item
export function resolveItemForTemplate(
  item: ListingItem,
  listing: Listing,
) {
  // Add sortable values for fields of variant types
  for (const col of Object.keys(listing[kColumnTypes])) {
    const type = listing[kColumnTypes][col];
    if (type === "date") {
      item.sortableValues[col] = (item[col] as Date).valueOf().toString();
    } else if (type === "number") {
      item.sortableValues[col] = (item[col] as number).toString();
    }
  }

  // Add sortable values for fields that will be linkerd
  listing[kColumnLinks].forEach((col) => {
    const val = item[col];
    if (val !== undefined) {
      item.sortableValues[col] = val as string;
    }
  });
}

// Options may also need computation / resolution before being handed
// off to the template. This function will do any computation on the options
// so they're ready for the template
export function reshapeListing(
  listing: Listing,
) {
  const reshaped = ld.cloneDeep(listing);
  if (reshaped.type === ListingType.Grid) {
    // Compute the bootstrap column span of each card
    reshaped[kCardColumnSpan] = columnSpan(
      reshaped[kColumnCount] as number,
    );
  }
  // Compute the sorting targets for the fields
  reshaped[kColumnSortTargets] = computeSortingTargets(reshaped);
  return reshaped;
}

// Determine the target value for sorting a field
// Fields need a special sorting target if they are a non-string
// data type (e.g. a number or date), or if they are going to be
// linked (since the 'value' will be surrounded by the href tag, which
// will interfere with sorthing)
function computeSortingTargets(
  listing: Listing,
): Record<string, string> {
  const sortingTargets: Record<string, string> = {};
  const columns = listing[kColumns];
  const columnLinks = listing[kColumnLinks];
  const columnTypes = listing[kColumnTypes];
  columns.forEach((column) => {
    // The data type of this column
    const columnType = columnTypes[column];

    // Figure out whether we should use a sort target or not
    const useTarget = columnLinks.includes(column) ||
      columnType === "date" ||
      columnType === "number";

    if (useTarget) {
      sortingTargets[column] = `${column}-value`;
    } else {
      sortingTargets[column] = column;
    }
  });
  return sortingTargets;
}

// Generates the script tag for this listing / template
// This binds list.js to the listing, enabling
// sorting, pagings, filtering, etc...
export function templateJsScript(
  id: string,
  listing: Listing,
  itemCount: number,
) {
  const columnCount = listing[kColumnCount] as number || 0;
  const rowCount = listing[kRowCount] as number || 50;

  // If columns are present, factor that in
  const pageCount = columnCount > 0 ? rowCount * columnCount : rowCount;

  const columns = listing[kColumns] as string[] || [];

  const pageJs = itemCount > pageCount
    ? `${pageCount ? `page: ${pageCount}` : ""},
    pagination: true,`
    : "";

  const useDataField = (col: string) => {
    const type = listing[kColumnTypes][col];
    if (type === "date" || type === "number") {
      return true;
    } else if (listing[kColumnLinks].includes(col)) {
      return true;
    }
    return false;
  };

  const formatItem = (col: string) => {
    if (useDataField(col)) {
      return [`"${col}"`, `{ attr: 'data-${col}-value', name: '${col}-value'}`];
    } else {
      return `"${col}"`;
    }
  };

  const rowJs = `[${
    columns.flatMap((col) => {
      return formatItem(col);
    }).join(",")
  }]`;

  const jsScript = `
  window.document.addEventListener("DOMContentLoaded", function (_event) {
    const options = {
      valueNames: ${rowJs},
      ${pageJs}
    };
    const userList = new List("${id}", options);
  });
  `;
  return jsScript;
}

// Forces a user input column value into the appropriate
// grid span bucket
const kGridColSize = 24;
const kGridValidSpans = [2, 3, 4, 6, 8, 12, 24];
function columnSpan(columns: number) {
  const rawValue = kGridColSize / columns;
  for (let i = 0; i < kGridValidSpans.length; i++) {
    const validSpan = kGridValidSpans[i];
    if (rawValue === validSpan) {
      return rawValue;
    } else if (
      i < kGridValidSpans.length && rawValue < kGridValidSpans[i + 1]
    ) {
      return validSpan;
    } else if (i === kGridValidSpans.length - 1) {
      return kGridValidSpans[i];
    }
  }
  return rawValue;
}

function truncateText(text: string, length: number) {
  if (text.length < length) {
    return text;
  } else {
    // Since we'll insert elips, trim an extra space
    const clipLength = length - 1;
    const clipped = text.substring(0, clipLength);
    const lastSpace = clipped.lastIndexOf(" ");
    if (lastSpace > 0) {
      return clipped.substring(0, lastSpace) + "…";
    } else {
      return clipped + "…";
    }
  }
}