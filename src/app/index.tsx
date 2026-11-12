import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Dimensions,
  Modal,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import type { MapPressEvent } from 'react-native-maps';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PlaceSearchModal, { type PlaceResult } from '@/components/place-search-modal';

// 서버가 안 될 때 대신 보여줄 '저장된 서버 응답'. (기본 구간(용산)으로 받은 응답)
// Swagger(/docs)에서 POST /routes 를 실행해 받은 응답을 그대로 저장한 파일이다.
import savedResponse from '../../assets/saved_routes_response.json';

type DistrictShare = {
  gu_name: string;
  share: number;
};

type ScenarioId = 'baseline' | 'half' | 'none';
type ScenarioScore = { score: number | null; rank: number | null };
type ScenarioWeights = {
  cctv: number;
  emergency_bell: number;
  crime_safety: number;
  safe_return: number;
};
type ScenarioDescriptor = { id: ScenarioId; label: string; weights: ScenarioWeights };

const SCENARIOS: { id: ScenarioId; title: string; subtitle: string }[] = [
  { id: 'baseline', title: '현재 기준', subtitle: '30.94%' },
  { id: 'half', title: '절반 반영', subtitle: '15.47%' },
  { id: 'none', title: 'CCTV 제외', subtitle: '0%' },
];

type RouteItem = {
  route_id: string;
  length_m: number;
  coordinates: [number, number][]; // [위도, 경도] 순서
  cctv_sites: number;
  emergency_bell_sites: number;
  facility_reference_score: number | null;
  cctv_reference_score?: number | null;
  emergency_bell_reference_score?: number | null;
  // 백엔드 v0.3 에서 추가된 필드. 옛 응답(옛 저장본)에는 없을 수 있어서 모두 선택 항목이다.
  streetlight_sites?: number;
  final_safety_score?: number | null;
  safety_rank?: number | null;
  crime_risk_score?: number | null;
  crime_risk_by_gu?: DistrictShare[];
  scenario_scores?: Partial<Record<ScenarioId, ScenarioScore>>;
};

type RoutesResponse = {
  count: number;
  notice: string;
  routes: RouteItem[];
  weight_scenarios?: ScenarioDescriptor[];
  scenario_version?: string;
  sensitivity_summary?: {
    baseline_top_route_id: string | null;
    top_route_by_scenario: Record<ScenarioId, string | null>;
    top_route_changed: Partial<Record<ScenarioId, boolean>>;
  };
};

type RouteRequestBody = {
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  candidate_count: number;
};

type LatLng = { latitude: number; longitude: number };

type Preset = { name: string; start: LatLng; end: LatLng };

// ---- routes api (start) ----
const ROUTES_TIMEOUT_MS = 180000; // 최초 OSM 도로망 요청은 60초를 넘을 수 있어 180초까지 허용

// 백엔드(route_engine.py)의 MAX_STRAIGHT_LINE_M 과 같은 값. 넘으면 서버가 400 에러를 낸다.
const MAX_STRAIGHT_M = 5000;
const MIN_STRAIGHT_M = 100; // 출발과 도착이 거의 같은 곳이면 경로를 만들 수 없다.

// 계산이 확인된 구간(캘리브레이션에서 경로가 나온 구간)과 구 경계를 넘는 예시.
const PRESETS: Preset[] = [
  {
    name: '용산 (기본)',
    start: { latitude: 37.5346, longitude: 127.0005 },
    end: { latitude: 37.5394, longitude: 127.0062 },
  },
  {
    name: '강남',
    start: { latitude: 37.4979, longitude: 127.0276 },
    end: { latitude: 37.505, longitude: 127.035 },
  },
  {
    name: '마포',
    start: { latitude: 37.5562, longitude: 126.9236 },
    end: { latitude: 37.5504, longitude: 126.9145 },
  },
  {
    name: '종로',
    start: { latitude: 37.5704, longitude: 126.9921 },
    end: { latitude: 37.576, longitude: 126.985 },
  },
  {
    name: '성동',
    start: { latitude: 37.5446, longitude: 127.0557 },
    end: { latitude: 37.5488, longitude: 127.0445 },
  },
  {
    name: '용산→성동 (구 경계)',
    start: { latitude: 37.5346, longitude: 127.0005 },
    end: { latitude: 37.54, longitude: 127.02 },
  },
];

// 두 지점 사이의 직선거리(m). 백엔드의 haversine_m 과 같은 식이다.
function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
}

// 서울 안인지 대충 보는 네모 범위. 서울에서 멀리 벗어난 곳(수원·인천 등)만 걸러내고,
// 서울 바로 옆 도시(구리·하남 등)는 이 범위 안이라 걸러내지 못한다. 그런 경우는 서버 응답에서
// 범죄 위험도·최종 점수가 비어 있게(카드에 '-') 나온다.
function inSeoulRough(p: LatLng): boolean {
  return (
    p.latitude >= 37.41 &&
    p.latitude <= 37.72 &&
    p.longitude >= 126.73 &&
    p.longitude <= 127.27
  );
}

type PairCheck = {
  ok: boolean;
  meters: number | null;
  message: string;
  warnOutsideSeoul: boolean;
};

function checkPair(start: LatLng | null, end: LatLng | null): PairCheck {
  if (!start) {
    return {
      ok: false,
      meters: null,
      message: '출발지를 지도에서 눌러 정해주세요',
      warnOutsideSeoul: false,
    };
  }
  if (!end) {
    return {
      ok: false,
      meters: null,
      message: '도착지를 지도에서 눌러 정해주세요',
      warnOutsideSeoul: false,
    };
  }
  const meters = haversineM(start, end);
  if (meters > MAX_STRAIGHT_M) {
    return {
      ok: false,
      meters,
      message: `직선거리 ${formatDistance(meters)} · 최대 ${MAX_STRAIGHT_M / 1000}km까지만 가능해요`,
      warnOutsideSeoul: false,
    };
  }
  if (meters < MIN_STRAIGHT_M) {
    return {
      ok: false,
      meters,
      message: '출발지와 도착지가 너무 가까워요',
      warnOutsideSeoul: false,
    };
  }
  return {
    ok: true,
    meters,
    message: `직선거리 ${formatDistance(meters)} (최대 ${MAX_STRAIGHT_M / 1000}km)`,
    warnOutsideSeoul: !inSeoulRough(start) || !inSeoulRough(end),
  };
}

function bodyFromPoints(start: LatLng, end: LatLng): RouteRequestBody {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    start_lat: r(start.latitude),
    start_lon: r(start.longitude),
    end_lat: r(end.latitude),
    end_lon: r(end.longitude),
    candidate_count: 3,
  };
}

function isSameRequest(a: RouteRequestBody, b: RouteRequestBody): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  return (
    near(a.start_lat, b.start_lat) &&
    near(a.start_lon, b.start_lon) &&
    near(a.end_lat, b.end_lat) &&
    near(a.end_lon, b.end_lon)
  );
}

function isNumberPair(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number'
  );
}

function isOptionalNumber(v: unknown): boolean {
  return v === undefined || v === null || typeof v === 'number';
}

function hasScenarioScores(r: RouteItem): boolean {
  return SCENARIOS.every(({ id }) => {
    const s = r.scenario_scores?.[id];
    return s && (s.score === null || (typeof s.score === 'number' && Number.isFinite(s.score))) &&
      (s.rank === null || (typeof s.rank === 'number' && Number.isInteger(s.rank)));
  });
}

function isDistrictShare(d: unknown): d is DistrictShare {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return typeof o.gu_name === 'string' && typeof o.share === 'number';
}

// 서버 응답에서 화면이 읽는 필드가 모두 있는지 확인한다.
// 필드 이름이 바뀌면 화면에 undefined 가 찍히는 대신 '형식이 달라요'로 실패 처리된다.
function isValidRoute(r: unknown): r is RouteItem {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.route_id === 'string' &&
    typeof o.length_m === 'number' &&
    typeof o.cctv_sites === 'number' &&
    typeof o.emergency_bell_sites === 'number' &&
    (o.facility_reference_score === null ||
      typeof o.facility_reference_score === 'number') &&
    Array.isArray(o.coordinates) &&
    o.coordinates.length >= 2 &&
    o.coordinates.every(isNumberPair) &&
    // 새로 추가된 필드는 없어도 되지만, 있다면 형식이 맞아야 한다.
    isOptionalNumber(o.streetlight_sites) &&
    isOptionalNumber(o.final_safety_score) &&
    isOptionalNumber(o.safety_rank) &&
    isOptionalNumber(o.crime_risk_score) &&
    (o.crime_risk_by_gu === undefined ||
      (Array.isArray(o.crime_risk_by_gu) &&
        o.crime_risk_by_gu.every(isDistrictShare)))
  );
}

function isValidResponse(x: unknown): x is RoutesResponse {
  if (!x || typeof x !== 'object') return false;
  const routes = (x as { routes?: unknown }).routes;
  return (
    Array.isArray(routes) && routes.length > 0 && routes.every(isValidRoute)
  );
}

// 응답 순서를 믿지 않고 safety_rank 순(1위 먼저)으로 정렬한다.
// 순위가 없는 경로는 맨 뒤로 가고, 순위가 같거나 없으면 원래 순서를 지킨다.
function orderByRank(routes: RouteItem[]): RouteItem[] {
  const rankOf = (r: RouteItem) => r.safety_rank ?? Number.MAX_SAFE_INTEGER;
  return routes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rankOf(a.r) - rankOf(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

async function requestRoutes(
  baseUrl: string,
  body: RouteRequestBody,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RoutesResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 서버가 400 으로 보낸 이유(detail)가 있으면 화면에 함께 보여준다.
      let detail = '';
      try {
        const j = (await res.json()) as { detail?: unknown };
        if (typeof j.detail === 'string') detail = j.detail;
      } catch {
        // 본문이 JSON 이 아니면 상태 코드만 쓴다.
      }
      throw new Error(
        detail ? `HTTP ${res.status}: ${detail.slice(0, 60)}` : `HTTP ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    if (!isValidResponse(json)) throw new Error('응답 형식이 달라요');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function errorReason(e: unknown): string {
  if (e instanceof Error) {
    return e.name === 'AbortError' ? '시간 초과' : e.message;
  }
  return '알 수 없는 오류';
}
// ---- routes api (end) ----

// 백엔드(FastAPI) 주소. 아래 순서로 정해진다.
// 1) 앱 폴더의 .env.local 에 EXPO_PUBLIC_SAFE_ROUTE_API_URL=http://IP:8000 이 적혀 있으면 그 주소
//    (백엔드를 다른 PC에서 돌릴 때만 쓴다. 평소에는 이 파일을 만들지 않는다)
// 2) 없으면 Expo 서버의 주소(폰이 지금 접속해 있는 PC의 IP)에서 IP를 읽어 :8000 을 붙인다
//    → 와이파이나 핫스팟을 바꿔도 코드를 고치지 않아도 된다. (같은 PC에서 두 서버를 켤 때)
// 3) 둘 다 안 되면(터널 모드 등) 아래 기본 주소를 쓴다.
function backendUrlFromHostUri(hostUri: string | undefined): string | null {
  if (!hostUri) return null;
  const host = hostUri.split(':')[0];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `http://${host}:8000` : null;
}

const API_BASE_URL =
  process.env.EXPO_PUBLIC_SAFE_ROUTE_API_URL ||
  backendUrlFromHostUri(Constants.expoConfig?.hostUri) ||
  'http://127.0.0.1:8000';

// 폰이 어느 주소로 백엔드에 접속하려는지 Expo 서버 창(LOG)에 찍어둔다.
console.log('[SafeRoute] 백엔드 주소:', API_BASE_URL);

// 처음 화면에 보여줄 기본 구간. (저장된 응답도 같은 좌표로 받은 것)
const ROUTE_REQUEST: RouteRequestBody = bodyFromPoints(
  PRESETS[0].start,
  PRESETS[0].end,
);

const SAVED: RoutesResponse | null = isValidResponse(savedResponse)
  ? savedResponse
  : null;

type RouteSource =
  | { kind: 'loading' }
  | { kind: 'live' }
  | { kind: 'saved'; reason: string } // 기본 구간 요청이 실패해서 저장본을 보여주는 중
  | { kind: 'failed'; reason: string }; // 새로 고른 구간 요청이 실패해서 이전 결과를 보여주는 중

type ServerStatus =
  | { state: 'checking' }
  | { state: 'ok'; version: string }
  | { state: 'down' };

type DrawnRoute = RouteItem & {
  index: number;
  color: string;
  path: LatLng[];
};

// 안전/위험을 뜻하는 색(초록·빨강)은 쓰지 않고, 경로를 구분하는 용도로만 색을 쓴다.
const ROUTE_COLORS = ['#2563EB', '#7C3AED', '#EA580C'];

// 화면 위·아래 여백. 하단 탭바와 카드가 겹치면 TAB_BAR_SPACE 값을 키우면 된다.
const TAB_BAR_SPACE = 90;

function toLatLng(coords: [number, number][]): LatLng[] {
  return coords.map(([latitude, longitude]) => ({ latitude, longitude }));
}

function formatScore(v: number | null | undefined): string {
  return v == null ? '-' : v.toFixed(1);
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scenario, setScenario] = useState<ScenarioId>('baseline');
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [data, setData] = useState<RoutesResponse | null>(SAVED);
  // 지금 화면의 경로를 만든 요청 / 마지막으로 시도한 요청
  const [request, setRequest] = useState<RouteRequestBody>(ROUTE_REQUEST);
  const [attempt, setAttempt] = useState<RouteRequestBody>(ROUTE_REQUEST);
  const [source, setSource] = useState<RouteSource>({ kind: 'loading' });
  const [server, setServer] = useState<ServerStatus>({ state: 'checking' });

  // 출발·도착 고르기
  const [picking, setPicking] = useState(false);
  const [pickStart, setPickStart] = useState<LatLng | null>(null);
  const [pickEnd, setPickEnd] = useState<LatLng | null>(null);
  const [target, setTarget] = useState<'start' | 'end'>('start');
  const [searchTarget, setSearchTarget] = useState<'start' | 'end' | null>(null);
  const [pickStartName, setPickStartName] = useState('');
  const [pickEndName, setPickEndName] = useState('');
  const [routeStartName, setRouteStartName] = useState('기본 출발지');
  const [routeEndName, setRouteEndName] = useState('기본 도착지');

  // 백엔드 /health 로 연결 상태를 확인한다. (5초 안에 응답이 없으면 실패 처리)
  const checkServer = useCallback(async () => {
    setServer({ state: 'checking' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${API_BASE_URL}/health`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { status?: string; version?: string };
      setServer(
        json.status === 'ok'
          ? { state: 'ok', version: json.version ?? '' }
          : { state: 'down' },
      );
    } catch {
      setServer({ state: 'down' });
    } finally {
      clearTimeout(timer);
    }
  }, []);

  // 백엔드 /routes 를 호출한다. 성공하면 true.
  // 실패했을 때: 기본 구간이면 저장된 응답을, 새로 고른 구간이면 이전 결과를 그대로 둔다.
  // (다른 구간의 저장본을 새 구간의 결과처럼 보여주면 안 되기 때문이다)
  const loadRoutes = useCallback(async (body: RouteRequestBody) => {
    setAttempt(body);
    setSource({ kind: 'loading' });
    try {
      const live = await requestRoutes(API_BASE_URL, body, ROUTES_TIMEOUT_MS);
      setData(live);
      setRequest(body);
      setSelected(0);
      setDetailsOpen(false);
      setScenario('baseline');
      setComparisonOpen(false);
      setSource({ kind: 'live' });
      return true;
    } catch (e) {
      const reason = errorReason(e);
      if (isSameRequest(body, ROUTE_REQUEST) && SAVED) {
        setData(SAVED);
        setRequest(ROUTE_REQUEST);
        setSelected(0);
        setSource({ kind: 'saved', reason });
      } else {
        setSource({ kind: 'failed', reason });
      }
      return false;
    }
  }, []);

  useEffect(() => {
    checkServer();
    loadRoutes(ROUTE_REQUEST);
  }, [checkServer, loadRoutes]);

  // v0.6 응답에 세 가지 실험 점수가 모두 있어야 모드 전환을 허용한다.
  // 서버가 이전 버전이면 기존 추천은 정상 표시하고 실험 버튼만 잠근다.
  const scenarioAvailable = !!data?.routes.length && data.routes.every(hasScenarioScores);
  const routes = useMemo<DrawnRoute[]>(() => {
    const rescored = (data?.routes ?? []).map((r) => {
      if (scenario === 'baseline' || !hasScenarioScores(r)) return r;
      return {
        ...r,
        final_safety_score: r.scenario_scores?.[scenario]?.score ?? null,
        safety_rank: r.scenario_scores?.[scenario]?.rank ?? null,
      };
    });
    return orderByRank(rescored).map((r, i) => ({
      ...r,
      index: i,
      // 지표가 바뀌어도 R1/R2/R3의 색을 유지한다.
      color: ROUTE_COLORS[Math.max(0, Number(r.route_id.replace(/\D/g, '')) - 1) % ROUTE_COLORS.length] ?? ROUTE_COLORS[i % ROUTE_COLORS.length],
      path: toLatLng(r.coordinates),
    }));
  }, [data, scenario]);

  // 실험 모드를 바꿀 때 지도 중심을 다시 맞추지 않도록 경로 지오메트리는 고정한다.
  const allPoints = useMemo(() =>
    (data?.routes ?? []).flatMap((r) => toLatLng(r.coordinates)), [data]);
  const changeScenario = (id: ScenarioId) => {
    if (!scenarioAvailable) return;
    setScenario(id);
    setSelected(0);
    setDetailsOpen(false);
  };
  const activeWeights = data?.weight_scenarios?.find((s) => s.id === scenario)?.weights;

  const check = useMemo(
    () => checkPair(pickStart, pickEnd),
    [pickStart, pickEnd],
  );

  // 고르는 중이 아닐 때, 지도가 준비되었거나 경로가 바뀔 때마다 모든 경로가 보이도록 맞춘다.
  useEffect(() => {
    if (picking || !mapReady || allPoints.length === 0) return;
    mapRef.current?.fitToCoordinates(allPoints, {
      edgePadding: { top: 120, right: 50, bottom: 340, left: 50 },
      animated: true,
    });
  }, [picking, mapReady, allPoints]);

  const fitPair = useCallback((a: LatLng, b: LatLng) => {
    mapRef.current?.fitToCoordinates([a, b], {
      edgePadding: { top: 180, right: 60, bottom: 400, left: 60 },
      animated: true,
    });
  }, []);

  const startPicking = () => {
    const a = { latitude: request.start_lat, longitude: request.start_lon };
    const b = { latitude: request.end_lat, longitude: request.end_lon };
    setPickStart(a);
    setPickEnd(b);
    setPickStartName(routeStartName);
    setPickEndName(routeEndName);
    setTarget('start');
    setPicking(true);
    fitPair(a, b);
  };

  const cancelPicking = () => setPicking(false);

  const resetPicking = () => {
    setPickStart(null);
    setPickEnd(null);
    setPickStartName('');
    setPickEndName('');
    setTarget('start');
  };

  const applyPreset = (p: Preset) => {
    setPickStart(p.start);
    setPickEnd(p.end);
    setPickStartName(`${p.name} 출발`);
    setPickEndName(`${p.name} 도착`);
    setTarget('end');
    fitPair(p.start, p.end);
  };

  const onMapPress = (e: MapPressEvent) => {
    if (!picking) return;
    const c = e.nativeEvent.coordinate;
    const point = { latitude: c.latitude, longitude: c.longitude };
    if (target === 'start') {
      setPickStart(point);
      setPickStartName('지도에서 선택한 출발지');
      setTarget('end');
    } else {
      setPickEnd(point);
      setPickEndName('지도에서 선택한 도착지');
    }
  };

  const selectPlace = (place: PlaceResult) => {
    const point = { latitude: place.latitude, longitude: place.longitude };
    if (searchTarget === 'start') {
      setPickStart(point);
      setPickStartName(place.name);
      setTarget('end');
    } else if (searchTarget === 'end') {
      setPickEnd(point);
      setPickEndName(place.name);
    }
    setSearchTarget(null);
    if (searchTarget === 'start' && pickEnd) fitPair(point, pickEnd);
    else if (searchTarget === 'end' && pickStart) fitPair(pickStart, point);
    else mapRef.current?.animateToRegion({ ...point, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 350);
  };

  const submitPick = async () => {
    if (!pickStart || !pickEnd || !check.ok || source.kind === 'loading') {
      return;
    }
    const ok = await loadRoutes(bodyFromPoints(pickStart, pickEnd));
    if (ok) {
      setRouteStartName(pickStartName || '지도에서 선택한 출발지');
      setRouteEndName(pickEndName || '지도에서 선택한 도착지');
      setPicking(false);
    }
  };

  if (routes.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>표시할 경로가 없어요.</Text>
        <Text style={styles.emptySub}>
          {source.kind === 'saved' || source.kind === 'failed'
            ? `서버 호출 실패(${source.reason}) · 저장된 응답도 없어요`
            : '경로 요청 중…'}
        </Text>
        <Pressable
          onPress={() => loadRoutes(attempt)}
          disabled={source.kind === 'loading'}
          style={styles.retry}
        >
          <Text style={styles.retryText}>다시 요청</Text>
        </Pressable>
      </View>
    );
  }

  const sourceText = source.kind === 'loading'
    ? '경로 계산 중…'
    : source.kind === 'live'
      ? '실시간 경로'
      : source.kind === 'saved'
        ? '저장된 예시 경로'
        : '경로 요청 실패 · 이전 결과';

  const serverText = server.state === 'checking'
    ? '서버 확인 중'
    : server.state === 'ok'
      ? '서버 연결됨'
      : '서버 연결 안 됨';
  const serverColor =
    server.state === 'ok'
      ? '#22C55E'
      : server.state === 'down'
        ? '#EF4444'
        : '#9CA3AF';

  const activeRoute = routes[selected] ?? routes[0];
  const activeDistricts = (activeRoute.crime_risk_by_gu ?? []).slice(0, 2).map(g => g.gu_name).join(' · ');

  const firstPath = routes[0].path;
  const start = firstPath[0];
  const end = firstPath[firstPath.length - 1];

  // 선택한 경로가 맨 위에 보이도록 마지막에 그린다.
  const drawOrder = [...routes].sort(
    (a, b) => Number(a.index === selected) - Number(b.index === selected),
  );

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: ROUTE_REQUEST.start_lat,
          longitude: ROUTE_REQUEST.start_lon,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
        onMapReady={() => setMapReady(true)}
        onPress={onMapPress}
      >
        {!picking &&
          drawOrder.map((r) => (
            <Polyline
              key={r.route_id}
              coordinates={r.path}
              strokeColor={r.index === selected ? r.color : `${r.color}88`}
              strokeWidth={r.index === selected ? 7 : 4}
              lineCap="round"
              lineJoin="round"
              tappable
              onPress={() => setSelected(r.index)}
            />
          ))}
        {!picking && <Marker coordinate={start} title="출발" pinColor="green" />}
        {!picking && <Marker coordinate={end} title="도착" pinColor="red" />}

        {picking && pickStart && (
          <Marker
            coordinate={pickStart}
            title="출발"
            pinColor="green"
            draggable
            onDragEnd={(e) => { setPickStart(e.nativeEvent.coordinate); setPickStartName('지도에서 선택한 출발지'); }}
          />
        )}
        {picking && pickEnd && (
          <Marker
            coordinate={pickEnd}
            title="도착"
            pinColor="red"
            draggable
            onDragEnd={(e) => { setPickEnd(e.nativeEvent.coordinate); setPickEndName('지도에서 선택한 도착지'); }}
          />
        )}
        {picking && pickStart && pickEnd && (
          <Polyline
            coordinates={[pickStart, pickEnd]}
            strokeColor="#374151"
            strokeWidth={3}
            lineDashPattern={[8, 6]}
          />
        )}
      </MapView>

      <View style={[styles.topArea, { top: insets.top + 12 }]} pointerEvents="box-none">
        {!picking ? (
          <Pressable style={styles.locationBar} onPress={startPicking} accessibilityRole="button" accessibilityLabel="출발지 도착지 변경">
            <View style={styles.locationNames}>
              <Text style={styles.locationText} numberOfLines={1}>● {routeStartName}</Text>
              <Text style={styles.locationText} numberOfLines={1}>⌖ {routeEndName}</Text>
            </View>
            <View style={styles.locationEdit}><Text style={styles.locationEditText}>검색·변경</Text></View>
          </Pressable>
        ) : (
          <View style={styles.locationBar}>
            <Text style={styles.locationText}>출발지·도착지 설정 중</Text>
          </View>
        )}
        <View style={styles.statusRow}>
          <Pressable style={styles.compactChip} onPress={() => loadRoutes(attempt)} disabled={source.kind === 'loading'}>
            {source.kind === 'loading' && <ActivityIndicator size="small" color="#fff" />}
            <Text style={styles.compactChipText}>{sourceText}</Text>
          </Pressable>
          <Pressable style={styles.compactChip} onPress={checkServer}>
            <View style={[styles.serverDot, { backgroundColor: serverColor }]} />
            <Text style={styles.compactChipText}>{serverText}</Text>
          </Pressable>
        </View>
      </View>

      {picking ? (
        <View style={styles.bottom}>
          <ScrollView style={styles.pickPanel} contentContainerStyle={styles.pickPanelContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.pickTitle}>출발·도착 고르기</Text>
            <Text style={styles.pickHelp}>
              장소명을 검색하거나 지도를 눌러 직접 선택할 수 있어요.
            </Text>
            <View style={styles.placePickRow}>
              <Pressable accessibilityRole="button" style={styles.placePickButton} onPress={() => setSearchTarget('start')}>
                <Text style={styles.placePickLabel}>출발지 검색</Text>
                <Text style={styles.placePickValue} numberOfLines={1}>{pickStartName || '가게·역 검색  ⌕'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.placePickButton} onPress={() => setSearchTarget('end')}>
                <Text style={styles.placePickLabel}>도착지 검색</Text>
                <Text style={styles.placePickValue} numberOfLines={1}>{pickEndName || '가게·역 검색  ⌕'}</Text>
              </Pressable>
            </View>
            <View style={styles.pickRow}>
              <Pressable
                style={[styles.toggle, target === 'start' && styles.toggleOn]}
                onPress={() => setTarget('start')}
              >
                <Text
                  style={[
                    styles.toggleText,
                    target === 'start' && styles.toggleTextOn,
                  ]}
                >
                  지도에서 출발 찍기
                </Text>
              </Pressable>
              <Pressable
                style={[styles.toggle, target === 'end' && styles.toggleOn]}
                onPress={() => setTarget('end')}
              >
                <Text
                  style={[
                    styles.toggleText,
                    target === 'end' && styles.toggleTextOn,
                  ]}
                >
                  지도에서 도착 찍기
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.pickMsg, !check.ok && styles.pickMsgBad]}>
              {check.message}
            </Text>
            {check.ok && check.warnOutsideSeoul && (
              <Text style={styles.pickWarn}>
                서울 밖이 섞이면 범죄 위험도와 최종 점수가 없을 수 있어요
              </Text>
            )}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {PRESETS.map((p) => (
                <Pressable
                  key={p.name}
                  style={styles.chip}
                  onPress={() => applyPreset(p)}
                >
                  <Text style={styles.chipText}>{p.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.pickRow}>
              <Pressable style={styles.ghostBtn} onPress={resetPicking}>
                <Text style={styles.ghostText}>초기화</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={cancelPicking}>
                <Text style={styles.ghostText}>취소</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.goBtn,
                  (!check.ok || source.kind === 'loading') && styles.goBtnOff,
                ]}
                onPress={submitPick}
                disabled={!check.ok || source.kind === 'loading'}
              >
                <Text style={styles.goText}>
                  {source.kind === 'loading' ? '요청 중…' : '경로 찾기'}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      ) : (
        <View style={styles.bottom}>
          <ScrollView style={styles.resultPanel} contentContainerStyle={styles.resultPanelContent} showsVerticalScrollIndicator={false}>
            <View style={styles.panelTop}>
              <View>
                <Text style={styles.panelHeading}>추천 경로 비교</Text>
                <Text style={styles.panelSubtitle}>후보 {routes.length}개 · 선택한 경로가 지도에서 강조돼요</Text>
              </View>
              <Pressable style={styles.panelRefresh} onPress={() => loadRoutes(attempt)} disabled={source.kind === 'loading'}>
                <Text style={styles.panelRefreshText}>새로고침</Text>
              </Pressable>
            </View>
            <View style={styles.scenarioHeader}>
              <Text style={styles.scenarioTitle}>CCTV 가중치 실험</Text>
              <Pressable onPress={() => setComparisonOpen(true)} disabled={!scenarioAvailable} accessibilityRole="button">
                <Text style={[styles.compareLink, !scenarioAvailable && styles.disabledText]}>3개 모델 비교표 보기 ›</Text>
              </Pressable>
            </View>
            <View style={styles.scenarioTabs}>
              {SCENARIOS.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}, CCTV ${item.subtitle}`}
                  accessibilityState={{ selected: scenario === item.id, disabled: !scenarioAvailable }}
                  disabled={!scenarioAvailable}
                  onPress={() => changeScenario(item.id)}
                  style={[styles.scenarioTab, scenario === item.id && styles.scenarioTabActive, !scenarioAvailable && styles.scenarioTabDisabled]}
                >
                  <Text style={[styles.scenarioTabTitle, scenario === item.id && styles.scenarioTabTitleActive]}>{item.title}</Text>
                  <Text style={[styles.scenarioTabPct, scenario === item.id && styles.scenarioTabTitleActive]}>{item.subtitle}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.scenarioHint}>
              {scenarioAvailable
                ? '동일한 경로를 재채점합니다 · 이동 경로 자체는 바뀌지 않아요'
                : '서버 응답에 실험 데이터가 없습니다 · 백엔드 v0.6을 실행해 주세요'}
            </Text>
            <View style={styles.routeTabs}>
              {routes.map(r => (
                <Pressable
                  key={r.route_id}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.route_id}, ${r.safety_rank ?? '-'}위, ${formatDistance(r.length_m)}, 선택`}
                  onPress={() => { setSelected(r.index); setDetailsOpen(false); }}
                  style={[styles.routeTab, r.index === selected && styles.routeTabActive, r.index === selected && { borderColor: r.color }]}
                >
                  <View style={[styles.routeTabDot, { backgroundColor: r.color }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.routeTabText, r.index === selected && styles.routeTabTextActive]} numberOfLines={1}>
                      {r.safety_rank != null ? `${r.safety_rank}위 ` : ''}{r.route_id}
                    </Text>
                    <Text style={styles.routeTabDistance}>{formatDistance(r.length_m)}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
            {(source.kind === 'saved' || source.kind === 'failed') && (
              <Text style={styles.sourceWarning} numberOfLines={3}>
                {source.kind === 'saved' ? '저장된 예시 경로입니다. ' : '이전 경로를 보여주고 있습니다. '}
                {source.reason}
              </Text>
            )}
            <View style={styles.summaryLine}>
              <View style={{flex: 1}}>
                <Text style={styles.activeLabel}>{activeRoute.safety_rank === 1 ? '추천 순위 1위' : '선택한 경로'} · {activeRoute.route_id}</Text>
                <Text style={styles.scoreLabel}>안전환경 참고점수 · {SCENARIOS.find((x) => x.id === scenario)?.title}</Text>
                <Text style={styles.scoreLarge}>{activeRoute.final_safety_score == null ? '점수 미산출' : formatScore(activeRoute.final_safety_score)}{activeRoute.final_safety_score != null && <Text style={styles.scoreUnit}> / 100</Text>}</Text>
              </View>
              <View style={styles.facilitySummary}>
                <Text style={styles.facilitySummaryHeading}>등록자료 기준 · 주변 50m</Text>
                <Text style={styles.facilitySummaryText}>CCTV {activeRoute.cctv_sites}곳</Text>
                <Text style={styles.facilitySummaryText}>비상벨 {activeRoute.emergency_bell_sites}곳</Text>
              </View>
            </View>
            <Pressable onPress={() => setDetailsOpen(v => !v)} style={styles.detailsToggle} accessibilityRole="button">
              <Text style={styles.detailsToggleText}>{detailsOpen ? '상세 지표 접기 ▲' : '점수 구성·지역 정보 자세히 ▼'}</Text>
            </Pressable>
            {detailsOpen && (
              <View style={styles.detailBox}>
                <Text style={styles.detailText}>시설 참고점수 {formatScore(activeRoute.facility_reference_score)} · 기존 참고값</Text>
                <Text style={styles.detailText}>CCTV 지표 {formatScore(activeRoute.cctv_reference_score)} · 비상벨 지표 {formatScore(activeRoute.emergency_bell_reference_score)}</Text>
                {activeWeights && <Text style={styles.detailText}>현재 적용 비율 · CCTV {(activeWeights.cctv * 100).toFixed(2)}% / 비상벨 {(activeWeights.emergency_bell * 100).toFixed(2)}% / 범죄 {(activeWeights.crime_safety * 100).toFixed(2)}% / 안심귀갓길 {(activeWeights.safe_return * 100).toFixed(2)}%</Text>}
                <Text style={styles.detailText}>지역 범죄 위험 참고값 {formatScore(activeRoute.crime_risk_score)} · 낮을수록 유리</Text>
                {activeDistricts ? <Text style={styles.detailText}>통과 지역 {activeDistricts}</Text> : null}
                {(activeRoute.streetlight_sites ?? 0) > 0 && (
                  <Text style={styles.detailText}>가로등 {activeRoute.streetlight_sites}곳 · 점수 제외 / 참고정보</Text>
                )}
              </View>
            )}
          </ScrollView>
          <Text style={styles.footnote}>
            공공데이터 기반 상대 비교값이며 실제 보행 안전을 보장하지 않습니다.
          </Text>
        </View>
      )}
      <Modal visible={comparisonOpen && scenarioAvailable} transparent animationType="fade" onRequestClose={() => setComparisonOpen(false)}>
        <View style={styles.compareBackdrop}>
          <View style={styles.compareDialog}>
            <View style={styles.compareTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.compareTitle}>CCTV 가중치 모델 비교</Text>
                <Text style={styles.compareSub}>같은 R1·R2·R3 경로 · 점수와 순위만 변경</Text>
              </View>
              <Pressable style={styles.compareClose} onPress={() => setComparisonOpen(false)} accessibilityRole="button">
                <Text style={styles.compareCloseText}>닫기</Text>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                <View style={styles.compareTableRow}>
                  <Text style={[styles.compareCell, styles.compareRouteCell, styles.compareColHeader]}>경로</Text>
                  {SCENARIOS.map((m) => <Text key={m.id} style={[styles.compareCell, styles.compareColHeader]}>{m.title}{'\n'}CCTV {m.subtitle}</Text>)}
                </View>
                {[...(data?.routes ?? [])].sort((a,b) => a.route_id.localeCompare(b.route_id)).map((r) => (
                  <View key={r.route_id} style={styles.compareTableRow}>
                    <Text style={[styles.compareCell, styles.compareRouteCell, styles.compareRouteName]}>{r.route_id}{'\n'}{formatDistance(r.length_m)}</Text>
                    {SCENARIOS.map((m) => {
                      const entry = r.scenario_scores?.[m.id];
                      return <Text key={m.id} style={[styles.compareCell, entry?.rank === 1 && styles.compareWinner]}>
                        {entry?.score == null ? '미산출' : `${entry.rank ?? '-'}위\n${formatScore(entry.score)}점`}
                      </Text>;
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
            <Text style={styles.compareNotice}>
              {data?.sensitivity_summary?.top_route_changed?.none
                ? 'CCTV 제외 모델에서 추천 1위가 변경됐어요.'
                : '이 구간에서는 CCTV를 제외해도 추천 1위가 유지돼요.'}
              {'\n'}점수 변화는 모형 민감도이며 실제 범죄 위험이나 안전 확률이 아닙니다.
            </Text>
          </View>
        </View>
      </Modal>
      <PlaceSearchModal
        visible={searchTarget !== null}
        target={searchTarget ?? 'start'}
        apiBaseUrl={API_BASE_URL}
        center={pickStart ?? { latitude: request.start_lat, longitude: request.start_lon }}
        onSelect={selectPlace}
        onClose={() => setSearchTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
    gap: 8,
    padding: 24,
  },
  emptyText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  emptySub: { color: '#9CA3AF', fontSize: 13, textAlign: 'center' },
  retry: {
    marginTop: 8,
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
  },
  retryText: { color: '#fff', fontWeight: '600' },
  topArea: {
    position: 'absolute', left: 12, right: 12, alignItems: 'stretch', gap: 7,
  },
  locationBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF', borderRadius: 16, paddingVertical: 10,
    paddingHorizontal: 14, gap: 10,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 5,
    shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  locationNames: { flex: 1, gap: 4 },
  locationText: { color: '#1F334B', fontSize: 13, fontWeight: '700' },
  locationEdit: { padding: 10, borderRadius: 11, backgroundColor: '#E8F0FF' },
  locationEditText: { color: '#1D4ED8', fontSize: 12, fontWeight: '800' },
  statusRow: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  compactChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(15,23,42,0.75)', borderRadius: 12,
    paddingHorizontal: 9, paddingVertical: 6, maxWidth: '56%',
  },
  compactChipText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  serverDot: { width: 7, height: 7, borderRadius: 4 },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: TAB_BAR_SPACE,
  },
  resultPanel: {
    maxHeight: Dimensions.get('window').height * 0.55,
    marginHorizontal: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  resultPanelContent: { paddingTop: 14, paddingBottom: 10 },
  scenarioHeader: { paddingHorizontal: 16, marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scenarioTitle: { color: '#17324C', fontSize: 12, fontWeight: '800' },
  compareLink: { color: '#1D4ED8', fontSize: 11, fontWeight: '800', paddingVertical: 4 },
  disabledText: { color: '#9CA3AF' },
  scenarioTabs: { flexDirection: 'row', paddingHorizontal: 14, gap: 6, paddingTop: 6 },
  scenarioTab: { flex: 1, alignItems: 'center', backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 10, paddingVertical: 7, minWidth: 0 },
  scenarioTabActive: { backgroundColor: '#E0F2FE', borderColor: '#0284C7' },
  scenarioTabDisabled: { opacity: 0.5 },
  scenarioTabTitle: { color: '#475569', fontSize: 11, fontWeight: '800' },
  scenarioTabPct: { color: '#64748B', fontSize: 11, marginTop: 2 },
  scenarioTabTitleActive: { color: '#075985' },
  scenarioHint: { color: '#64748B', fontSize: 10, marginTop: 6, paddingHorizontal: 16 },
  compareBackdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: 14, backgroundColor: 'rgba(15,23,42,0.6)' },
  compareDialog: { backgroundColor: '#fff', padding: 16, borderRadius: 20, maxHeight: '80%' },
  compareTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, gap: 12 },
  compareTitle: { fontSize: 17, fontWeight: '800', color: '#0F172A' },
  compareSub: { fontSize: 11, color: '#64748B', marginTop: 4 },
  compareClose: { backgroundColor: '#E2E8F0', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9 },
  compareCloseText: { color: '#334155', fontSize: 12, fontWeight: '800' },
  compareTableRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#E2E8F0', alignItems: 'center' },
  compareCell: { width: 91, minHeight: 57, textAlign: 'center', textAlignVertical: 'center', paddingVertical: 9, paddingHorizontal: 4, color: '#334155', fontSize: 12, lineHeight: 19 },
  compareRouteCell: { width: 70 },
  compareColHeader: { fontSize: 10, fontWeight: '800', color: '#475569', backgroundColor: '#F1F5F9' },
  compareRouteName: { fontWeight: '800' },
  compareWinner: { color: '#0369A1', fontWeight: '800', backgroundColor: '#E0F2FE' },
  compareNotice: { marginTop: 12, color: '#64748B', fontSize: 12, lineHeight: 20 },
  panelTop: { paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  panelHeading: { fontSize: 17, fontWeight: '800', color: '#111827' },
  panelSubtitle: { fontSize: 11, color: '#6B7280', marginTop: 3 },
  panelRefresh: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9, backgroundColor: '#F3F4F6' },
  panelRefreshText: { fontSize: 11, fontWeight: '700', color: '#374151' },
  routeTabs: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 13, paddingBottom: 7, gap: 6 },
  routeTab: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: '#F9FAFB', paddingVertical: 9, paddingHorizontal: 7, gap: 5 },
  routeTabActive: { backgroundColor: '#EFF6FF' },
  routeTabDot: { width: 8, height: 8, borderRadius: 4 },
  routeTabText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  routeTabTextActive: { color: '#111827', fontWeight: '800' },
  routeTabDistance: { fontSize: 11, color: '#6B7280', marginTop: 2 },
  sourceWarning: { color: '#92400E', fontSize: 11, lineHeight: 17, paddingHorizontal: 16, paddingTop: 5 },
  summaryLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 7 },
  activeLabel: { fontSize: 12, color: '#1D4ED8', fontWeight: '800' },
  scoreLabel: { fontSize: 11, color: '#6B7280', marginTop: 5 },
  scoreLarge: { fontSize: 30, fontWeight: '800', color: '#111827', marginTop: 3 },
  scoreUnit: { fontSize: 12, color: '#6B7280', fontWeight: '400' },
  facilitySummary: { backgroundColor: '#F3F4F6', padding: 10, borderRadius: 12, minWidth: 122, gap: 3 },
  facilitySummaryHeading: { fontSize: 11, color: '#6B7280', marginBottom: 3 },
  facilitySummaryText: { fontSize: 12, color: '#1F2937', fontWeight: '700' },
  detailsToggle: { alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  detailsToggleText: { color: '#2563EB', fontSize: 12, fontWeight: '700' },
  detailBox: { marginHorizontal: 16, marginTop: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 10, gap: 6 },
  detailText: { color: '#374151', fontSize: 12 },
  cardRow: { paddingHorizontal: 16, gap: 10 },
  card: {
    width: 200,
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 2,
    padding: 12,
    gap: 4,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardTitle: { color: '#111', fontSize: 15, fontWeight: '700' },
  cardDistance: {
    color: '#444',
    fontSize: 13,
    marginLeft: 'auto',
  },
  cardScore: { color: '#111', fontSize: 15, fontWeight: '700', marginTop: 2 },
  cardLine: { color: '#222', fontSize: 13 },
  cardNote: { color: '#6B7280', fontSize: 12 },
  footnote: {
    color: '#fff',
    fontSize: 11,
    backgroundColor: 'rgba(0,0,0,0.7)',
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
  pickPanel: {
    marginHorizontal: 12,
    maxHeight: Dimensions.get('window').height * 0.60,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
  },
  pickPanelContent: { gap: 8, paddingBottom: 5 },
  placePickRow: { flexDirection: 'row', gap: 8 },
  placePickButton: { flex: 1, backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE', borderRadius: 12, padding: 10 },
  placePickLabel: { color: '#475569', fontWeight: '600', fontSize: 11 },
  placePickValue: { color: '#17324C', fontWeight: '800', fontSize: 12, marginTop: 6 },
  pickTitle: { color: '#111', fontSize: 16, fontWeight: '700' },
  pickHelp: { color: '#6B7280', fontSize: 12 },
  pickRow: { flexDirection: 'row', gap: 8 },
  toggle: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  toggleOn: { backgroundColor: '#111', borderColor: '#111' },
  toggleText: { color: '#374151', fontSize: 13, fontWeight: '600' },
  toggleTextOn: { color: '#fff' },
  pickMsg: { color: '#111', fontSize: 13, fontWeight: '600' },
  pickMsgBad: { color: '#B91C1C' },
  pickWarn: { color: '#B45309', fontSize: 12 },
  chipRow: { gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#E5E7EB',
  },
  chipText: { color: '#111', fontSize: 12, fontWeight: '600' },
  ghostBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
  },
  ghostText: { color: '#374151', fontSize: 14, fontWeight: '600' },
  goBtn: {
    flex: 2,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#2563EB',
  },
  goBtnOff: { backgroundColor: '#9CA3AF' },
  goText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
