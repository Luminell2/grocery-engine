// Shared contracts for the grocery price engine.
// Money is always stored in minor units (cents, kopecks, tiyn) to avoid float drift.

export type Unit = 'g' | 'ml' | 'pcs';

export interface Quantity {
  amount: number;
  unit: Unit;
}

/** A single ingredient line coming from the meal plan (one recipe or aggregated). */
export interface Ingredient {
  /** Canonical English name, e.g. "cherry tomatoes". */
  name: string;
  /** How much the recipes need in total. */
  qty: Quantity;
  /** Grocery-list section: "Fruit & Veg", "Dairy", ... */
  category?: string;
  /** Pantry staples (salt, oil...) are priced but can be hidden / marked "you probably have it". */
  pantry?: boolean;
}

export interface Offer {
  storeId: string;
  productId: string;
  name: string;
  brand?: string;
  /** Shelf price for ONE pack, minor units. */
  price: number;
  /** Price before promotion, minor units. */
  regularPrice?: number;
  currency: string;
  /** Pack content, if known (500 g, 1 l -> 1000 ml, 6 pcs). */
  pack?: Quantity;
  /** Price per kg / l / pcs in minor units, computed when pack is known. */
  unitPrice?: number;
  url?: string;
  image?: string;
  gtin?: string;
  inStock?: boolean;
  /** Data provenance: 'live' API, 'dataset' daily dump, 'crowd' Open Prices. */
  source: 'live' | 'dataset' | 'crowd' | 'aggregator';
  observedAt?: string;
}

export interface StoreContext {
  /** Postal code, used by stores with regional pricing (Rewe). */
  postalCode?: string;
  /** Wolt / Glovo need coordinates. */
  lat?: number;
  lon?: number;
  /** Connector-specific store / branch / venue id. */
  branchId?: string;
  language?: string;
}

export type CartMode =
  | 'api' // we can create a real cart / order link server-side
  | 'deeplink' // we open the store with the list / products, user taps "add"
  | 'list'; // we only export a shopping list (text / share sheet)

export interface StoreInfo {
  id: string;
  name: string;
  chain: string;
  country: string; // ISO-3166 alpha-2
  currency: string;
  /** Primary language used for search queries (ISO-639-1). */
  language: string;
  cart: CartMode;
  source: Offer['source'];
  /** Needs a store context (postal code / coordinates / branch) to price. */
  needs?: Array<keyof StoreContext>;
  notes?: string;
}

export interface StoreConnector {
  info: StoreInfo;
  /** Free-text product search. Query is already translated into info.language. */
  search(query: string, ctx: StoreContext, limit?: number): Promise<Offer[]>;
}

export interface BasketLine {
  ingredient: Ingredient;
  offer?: Offer;
  packs: number;
  /** packs * offer.price */
  cost: number;
  /** Share of the bought packs actually used by recipes (for "leftover" UI). */
  usedFraction?: number;
  alternatives: Offer[];
  query: string;
  /** Set when the exact ingredient wasn't sold and a broader one was bought (red onion -> onion). */
  substitutedWith?: string;
  status: 'matched' | 'not_found' | 'error';
  error?: string;
}

export interface BasketQuote {
  store: StoreInfo;
  currency: string;
  total: number;
  /** Cost attributable to the quantities actually used (pro-rata), useful for per-meal cost. */
  usedCost: number;
  lines: BasketLine[];
  matched: number;
  missing: number;
  tookMs: number;
}

export interface Meal {
  id: string;
  title: string;
  servings: number;
  tags?: string[];
  ingredients: Ingredient[];
  kcal?: number;
  minutes?: number;
  image?: string;
}
