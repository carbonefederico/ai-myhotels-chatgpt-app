/**
 * Browser-side widget runtime that renders hotel results, member pricing, and booking approval state.
 */
// Types
interface Hotel {
  id: string;
  name: string;
  imageUrl?: string;
  location: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  rating: number;
  standardRate: number;
  memberRate?: number;
  savings?: number;
  amenities: string[];
}

interface BookingApproval {
  transactionId: string;
  hotelId: string;
  hotelName: string;
  bindingMessage: string;
  startDate: string;
  nights: number;
  nightlyRate: number;
  totalPrice: number;
  currency: string;
  requiredScope: string;
  status: string;
  updatedAt: string;
  pollIntervalSeconds: number;
  approvalCompletedAt?: string;
  approvedScopes?: string;
  hasRefreshToken?: boolean;
}

interface BookingDraft {
  hotelId: string;
  hotelName: string;
}

interface AuthenticatedUser {
  firstName?: string;
  username?: string;
  sub?: string;
  displayName: string;
}

// Declare Leaflet types
declare const L: any;

// Module-level state
let hotels: Hotel[] = [];
let showingMemberRates = false;
let currentBookingApproval: BookingApproval | null = null;
let currentBookingDraft: BookingDraft | null = null;
let currentUiError: string | null = null;
let currentAuthenticatedUser: AuthenticatedUser | null = null;
let map: any = null;
let markers: any[] = [];
let bookingStatusPollTimer: number | null = null;

// Declare global window.openai API
declare global {
  interface Window {
    openai: {
      toolOutput?: any;
      toolInput?: any;
      callTool: (name: string, args: any) => Promise<any>;
      sendFollowUpMessage: (options: { prompt: string }) => Promise<void>;
    };
  }
}

// DOM Elements
const loadingEl = document.getElementById("loading")!;
const mapViewEl = document.getElementById("map-view")!;
const mapControlsEl = document.getElementById("map-controls")!;
const emptyStateEl = document.getElementById("empty-state")!;
const brandNameEl = document.getElementById("brand-name")!;

/** Formats a numeric amount with a single currency presentation. */
function formatMoney(amount: number, currency?: string): string {
  const normalizedCurrency = (currency || "EUR").toUpperCase();
  const symbolByCurrency: Record<string, string> = {
    EUR: "€",
    USD: "$",
    GBP: "£",
  };

  const symbol = symbolByCurrency[normalizedCurrency];
  if (symbol) {
    return `${symbol}${amount}`;
  }

  return `${amount} ${normalizedCurrency}`;
}

/** Creates the Leaflet map instance the first time the widget needs it. */
function mountMapCanvas(): void {
  if (map) return; // Already initialized

  // Create map centered on Paris by default
  map = L.map('map', { attributionControl: false }).setView([48.8566, 2.3522], 12);

  // Keep the map light, but bring back a bit more street and landmark detail.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19,
  }).addTo(map);
}

/** Builds the custom price pin shown for each hotel marker. */
function buildRatePinIcon(hotel: Hotel): any {
  const price = showingMemberRates && hotel.memberRate ? hotel.memberRate : hotel.standardRate;
  const isDiscounted = showingMemberRates && hotel.memberRate && hotel.memberRate < hotel.standardRate;

  const html = `
    <div class="rate-pin ${isDiscounted ? 'rate-pin--member' : ''}">
      <span class="rate-pin__currency">€</span>
      <span class="rate-pin__value">${price}</span>
    </div>
  `;

  return L.divIcon({
    className: 'map-pin',
    html: html,
    iconSize: [74, 40],
    iconAnchor: [37, 20],
  });
}

/** Renders either a hotel image tag or a branded fallback tile. */
function renderHotelImage(hotel: Hotel, className: string): string {
  if (hotel.imageUrl) {
    return `<img class="${className}" src="${hotel.imageUrl}" alt="${hotel.name}" loading="lazy" />`;
  }

  return `
    <div class="${className} media-fallback" aria-hidden="true">
      <span>${hotel.name.split(' ').slice(0, 2).join(' ')}</span>
    </div>
  `;
}

/** Renders the booking approval summary card shown above the map. */
function renderApprovalCard(): string {
  if (!currentBookingApproval) {
    return "";
  }

  return `
    <div class="notice-card notice-card--approval">
      <div class="notice-card__header">
        <h3>${renderBookingTitle(currentBookingApproval.status)}</h3>
        <button type="button" id="close-approval-btn" class="notice-card__close" aria-label="Close booking finalization">Close</button>
      </div>
      <div class="notice-card__body">
        <p>${currentBookingApproval.hotelName} from ${currentBookingApproval.startDate} for ${currentBookingApproval.nights} night(s).</p>
        <p>Total: ${formatMoney(currentBookingApproval.totalPrice, currentBookingApproval.currency)}.</p>
        <p>${renderBookingMessage(currentBookingApproval)}</p>
      </div>
      <div class="notice-card__badge">${currentBookingApproval.status.replace(/_/g, " ")}</div>
    </div>
  `;
}

/** Renders the transient error notice shown when a tool call fails. */
function renderErrorCard(): string {
  if (!currentUiError) {
    return "";
  }

  return `
    <div class="notice-card notice-card--error">
      <div>
        <h3>Couldn’t complete that action</h3>
        <p>${currentUiError}</p>
      </div>
    </div>
  `;
}

/** Renders the inline booking form for the currently selected hotel. */
function renderBookingForm(): string {
  if (!currentBookingDraft) {
    return "";
  }

  return `
    <form id="booking-form" class="booking-panel">
      <button type="button" id="close-booking-btn" class="booking-panel__close" aria-label="Close booking form">×</button>
      <div class="booking-panel__intro">
        <h3>Book ${currentBookingDraft.hotelName}</h3>
        <p>Select the hotel booking details, then submit your request.</p>
      </div>
      <label>
        Check-in
        <input id="booking-start-date" name="startDate" type="date" required />
      </label>
      <label>
        Nights
        <input id="booking-nights" name="nights" type="number" min="1" max="30" value="2" required />
      </label>
      <div class="booking-panel__actions">
        <button type="submit" class="action-chip action-chip--primary">Book</button>
      </div>
    </form>
  `;
}

/** Renders the toolbar above the map, including member-pricing actions. */
function renderMapHeader(): string {
  if (hotels.length === 0) {
    return `
      <div class="results-toolbar">
        <h2>Waiting for hotel search...</h2>
      </div>
    `;
  }

  const memberRatesControl = !showingMemberRates
    ? `
        <div class="toolbar-actions">
          <button id="ask-member-rates-btn" class="action-chip action-chip--primary">
            💬 Show Member Rates
          </button>
        </div>
      `
    : `<div class="member-flag">✓ Member Rates Active</div>`;

  return `
    <div class="results-toolbar">
      <h2>${hotels.length} Hotels Found</h2>
      ${memberRatesControl}
    </div>
  `;
}

/** Updates the masthead brand label with the authenticated member display name when available. */
function renderBrandName(): void {
  brandNameEl.textContent = currentAuthenticatedUser
    ? `MyHotels (${currentAuthenticatedUser.displayName})`
    : "MyHotels";
}

/** Rebuilds the non-map control area above the result map. */
function renderControls(): void {
  mapControlsEl.innerHTML = `
    ${renderApprovalCard()}
    ${renderErrorCard()}
    ${renderBookingForm()}
    ${renderMapHeader()}
  `;
}

/** Attaches event handlers to the currently rendered control elements. */
function bindControlEvents(): void {
  const closeApprovalBtn = document.getElementById("close-approval-btn");
  closeApprovalBtn?.addEventListener("click", () => {
    stopBookingStatusPolling();
    currentBookingApproval = null;
    renderHotelMapView();
  });

  if (!showingMemberRates && hotels.length > 0) {
    const askMemberRatesBtn = document.getElementById("ask-member-rates-btn");
    askMemberRatesBtn?.addEventListener("click", requestMemberPricing);
  }

  if (!currentBookingDraft) {
    return;
  }

  const bookingForm = document.getElementById("booking-form") as HTMLFormElement | null;
  const closeBookingBtn = document.getElementById("close-booking-btn");

  bookingForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const startDateInput = document.getElementById("booking-start-date") as HTMLInputElement | null;
    const nightsInput = document.getElementById("booking-nights") as HTMLInputElement | null;
    void submitBookingRequest(startDateInput?.value || "", nightsInput?.value || "");
  });

  closeBookingBtn?.addEventListener("click", () => {
    currentBookingDraft = null;
    renderHotelMapView();
  });
}

/** Ensures the Leaflet map exists and has the correct size after each rerender. */
function ensureMapReady(): void {
  if (!map) {
    mountMapCanvas();
    setTimeout(() => {
      map?.invalidateSize();
    }, 100);
    return;
  }

  map.invalidateSize();
}

/** Removes all currently rendered hotel markers from the map. */
function clearMarkers(): void {
  markers.forEach((marker) => marker.remove());
  markers = [];
}

/** Builds the popup card shown when a hotel marker is opened. */
function renderHotelPopup(hotel: Hotel): string {
  const savings = hotel.memberRate ? hotel.standardRate - hotel.memberRate : 0;
  const pricing = showingMemberRates && hotel.memberRate
    ? `
        <div class="hotel-pricing">
          <div class="hotel-pricing__was">Was: €${hotel.standardRate}</div>
          <div class="hotel-pricing__now">Member: €${hotel.memberRate}</div>
          <div class="hotel-pricing__delta">Save €${savings}/night</div>
        </div>
      `
    : `
        <div class="hotel-pricing">
          <div class="hotel-pricing__standard">€${hotel.standardRate}/night</div>
        </div>
      `;

  return `
    <div class="hotel-card">
      <div class="hotel-card__media">
        ${renderHotelImage(hotel, "hotel-card__image")}
      </div>
      <h3>${hotel.name}</h3>
      <div class="hotel-card__rating">${"⭐".repeat(Math.floor(hotel.rating))} ${hotel.rating}</div>
      <p class="hotel-card__location">${hotel.location}</p>
      <p class="hotel-card__region">${hotel.city}, ${hotel.country}</p>
      ${pricing}
      <div class="hotel-card__actions">
        <button class="action-chip action-chip--primary book-hotel-btn" data-hotel-id="${hotel.id}">
          Book
        </button>
      </div>
    </div>
  `;
}

/** Adds map markers for the current hotel set and returns their coordinate bounds. */
function addHotelMarkers(): any[] {
  const bounds: any[] = [];

  hotels.forEach((hotel) => {
    const marker = L.marker([hotel.latitude, hotel.longitude], {
      icon: buildRatePinIcon(hotel),
    }).addTo(map);

    marker.bindPopup(renderHotelPopup(hotel));
    marker.on("popupopen", (event: any) => {
      const popupElement = event.popup?.getElement?.();
      const bookButton = popupElement?.querySelector(".book-hotel-btn");
      bookButton?.addEventListener("click", () => {
        void startBookingDraft(hotel.id);
      }, { once: true });
    });

    markers.push(marker);
    bounds.push([hotel.latitude, hotel.longitude]);
  });

  return bounds;
}

/** Fits the visible map viewport to the active hotel coordinates. */
function fitMapToHotels(bounds: any[]): void {
  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [50, 50] });
  }
}

// Render map with hotel markers
/** Renders the active hotel map view and all map-adjacent controls. */
function renderHotelMapView(): void {
  loadingEl.classList.add("hidden");
  emptyStateEl.classList.add("hidden");
  mapViewEl.classList.remove("hidden");

  renderControls();
  bindControlEvents();
  ensureMapReady();
  clearMarkers();

  if (hotels.length === 0) {
    return;
  }

  fitMapToHotels(addHotelMarkers());
}

/** Maps a booking status into the approval card title text. */
function renderBookingTitle(status: string): string {
  switch (status) {
    case "approved":
      return "Booking Ready";
    case "denied":
      return "Booking Not Confirmed";
    case "expired":
      return "Booking Timed Out";
    default:
      return "Booking in Progress";
  }
}

/** Maps a booking status into the approval card body copy. */
function renderBookingMessage(booking: BookingApproval): string {
  switch (booking.status) {
    case "approved":
      return "Your booking request has been approved and is ready to continue.";
    case "denied":
      return "The booking request was not approved.";
    case "expired":
      return "This booking request timed out before it could be completed.";
    default:
      return "We’re waiting for booking confirmation. Please approve the request on your device.";
  }
}

/** Cancels any in-flight polling timer for booking-intent updates. */
function stopBookingStatusPolling(): void {
  if (bookingStatusPollTimer !== null) {
    window.clearTimeout(bookingStatusPollTimer);
    bookingStatusPollTimer = null;
  }
}

/** Starts polling only when the current booking is still waiting for approval. */
function maybeStartBookingStatusPolling(): void {
  stopBookingStatusPolling();

  if (!currentBookingApproval || currentBookingApproval.status !== "pending_user_approval") {
    return;
  }

  bookingStatusPollTimer = window.setTimeout(() => {
    void fetchBookingStatus(currentBookingApproval.transactionId);
  }, 3000);
}

/** Applies hotel search results from the latest tool payload into widget state. */
function applyHotelResults(toolOutput: any): void {
  if (toolOutput?.hotels && Array.isArray(toolOutput.hotels)) {
    loadingEl.classList.add("hidden");
    hotels = toolOutput.hotels;
    showingMemberRates = toolOutput.authenticated === true;
  }
}

/** Applies booking-intent status data from the latest tool payload into widget state. */
function applyBookingApproval(toolOutput: any): void {
  if (toolOutput?.bookingApproval) {
    currentBookingApproval = toolOutput.bookingApproval as BookingApproval;
    currentBookingDraft = null;
    currentUiError = null;
  }
}

/** Applies normalized authenticated-user data from the latest tool payload into widget state. */
function applyAuthenticatedUser(toolOutput: any): void {
  if (toolOutput?.authenticatedUser) {
    currentAuthenticatedUser = toolOutput.authenticatedUser as AuthenticatedUser;
  }
}

/** Reconciles the widget's local state from a ChatGPT tool output payload. */
function applyWidgetStateFromToolOutput(toolOutput: any): void {
  applyHotelResults(toolOutput);
  applyBookingApproval(toolOutput);
  applyAuthenticatedUser(toolOutput);

  renderBrandName();
  renderHotelMapView();
  maybeStartBookingStatusPolling();
}

/** Extracts the most useful text error message from a tool result payload. */
function getToolErrorMessage(result: any, fallback: string): string {
  const textMessage = result?.content?.find?.((item: any) => item?.type === "text")?.text;
  return textMessage || fallback;
}

/** Asks ChatGPT to run the protected member-pricing tool for the current result set. */
async function requestMemberPricing(): Promise<void> {
  try {
    currentUiError = null;
    await window.openai.sendFollowUpMessage({
      prompt: "Please call the search_hotels_member_rates tool to show me member pricing for these hotels."
    });
  } catch (error) {
    console.error("Error sending follow-up message:", error);
    currentUiError = "Couldn’t request member pricing right now.";
    renderHotelMapView();
  }
}

/** Opens the inline booking form for the selected hotel marker. */
async function startBookingDraft(hotelId: string): Promise<void> {
  const hotel = hotels.find(item => item.id === hotelId);
  if (!hotel) {
    return;
  }

  currentBookingDraft = {
    hotelId: hotel.id,
    hotelName: hotel.name,
  };
  currentBookingApproval = null;
  currentUiError = null;
  renderHotelMapView();
}

/** Validates the inline booking form and calls the booking-intent creation tool. */
async function submitBookingRequest(startDate: string, nightsInput: string): Promise<void> {
  if (!currentBookingDraft) {
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return;
  }

  const nights = Number.parseInt(nightsInput, 10);
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) {
    return;
  }

  try {
    const result = await window.openai.callTool("prepare_booking", {
      hotelId: currentBookingDraft.hotelId,
      startDate,
      nights,
    });

    const toolOutput = result?.structuredContent || result;
    if (toolOutput?.bookingApproval) {
      applyWidgetStateFromToolOutput(toolOutput);
      return;
    }

    currentUiError = getToolErrorMessage(
      result,
      "Couldn’t start booking approval."
    );
    renderHotelMapView();
  } catch (error) {
    console.error("Error preparing booking:", error);
    currentUiError = "Couldn’t start booking approval.";
    renderHotelMapView();
  }
}

/** Attempts to finalize the booking, returning pending state while approval is incomplete. */
async function fetchBookingStatus(transactionId: string): Promise<void> {
  try {
    const result = await window.openai.callTool("finalize_booking", {
      transactionId,
    });

    const toolOutput = result?.structuredContent || result;
    if (toolOutput?.bookingApproval) {
      applyWidgetStateFromToolOutput(toolOutput);
      return;
    }
    currentUiError = getToolErrorMessage(
      result,
      "Couldn’t finalize booking."
    );
    stopBookingStatusPolling();
    renderHotelMapView();
  } catch (error) {
    console.error("Error finalizing booking:", error);
    stopBookingStatusPolling();
    currentUiError = "Couldn’t finalize booking.";
    renderHotelMapView();
  }
}

/** Boots the widget, subscribes to ChatGPT globals, and performs the first render. */
async function bootstrapWidget(): Promise<void> {
  // Listen for global updates from ChatGPT
  window.addEventListener("openai:set_globals", (event: any) => {
    const { toolOutput } = event.detail.globals || {};
    applyWidgetStateFromToolOutput(toolOutput);
  });

  // Check for initial data from window.openai.toolOutput
  if (window.openai?.toolOutput?.hotels && Array.isArray(window.openai.toolOutput.hotels)) {
    applyWidgetStateFromToolOutput(window.openai.toolOutput);
  }

  // Initial render
  renderBrandName();
  renderHotelMapView();
}

// Start the app
bootstrapWidget();
