import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import type { MapPressEvent } from 'react-native-maps';
import Constants from 'expo-constants';

// 서버가 안 될 때 대신 보여줄 '저장된 서버 응답'. (기본 구간(용산)으로 받은 응답)
// Swagger(/docs)에서 POST /routes 를 실행해 받은 응답을 그대로 저장한 파일이다.
import savedResponse from '../../assets/saved_routes_response.json';

type DistrictShare = {
  gu_name: string;
  share: number;
};

type RouteItem = {
  route_id: string;
  length_m: number;
  coordinates: [number, number][]; // [위도, 경도] 순서
  cctv_sites: number;
  emergency_bell_sites: number;
  facility_reference_score: number | null;
  // 백엔드 v0.3 에서 추가된 필드. 옛 응답(옛 저장본)에는 없을 수 있어서 모두 선택 항목이다.
  streetlight_sites?: number;
  final_safety_score?: number | null;
  safety_rank?: number | null;
  crime_risk_score?: number | null;
  crime_risk_by_gu?: DistrictShare[];
};

type RoutesResponse = {
  count: number;
  notice: string;
  routes: RouteItem[];
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
const ROUTES_TIMEOUT_MS = 60000; // 서버가 도로망을 받아오느라 오래 걸릴 수 있어서 넉넉하게 60초

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
  'http://172.20.10.4:8000';

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
const TOP_SPACE = 60;
const TAB_BAR_SPACE = 90;

function toLatLng(coords: [number, number][]): LatLng[] {
  return coords.map(([latitude, longitude]) => ({ latitude, longitude }));
}

function formatScore(v: number | null | undefined): string {
  return v == null ? '-' : v.toFixed(1);
}

export default function HomeScreen() {
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selected, setSelected] = useState(0);
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

  // 추천 순위(safety_rank) 순으로 정렬해서, 1위 경로가 항상 첫 카드·첫 색이 되게 한다.
  const routes = useMemo<DrawnRoute[]>(
    () =>
      orderByRank(data?.routes ?? []).map((r, i) => ({
        ...r,
        index: i,
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        path: toLatLng(r.coordinates),
      })),
    [data],
  );

  const allPoints = useMemo(() => routes.flatMap((r) => r.path), [routes]);

  const check = useMemo(
    () => checkPair(pickStart, pickEnd),
    [pickStart, pickEnd],
  );

  // 고르는 중이 아닐 때, 지도가 준비되었거나 경로가 바뀔 때마다 모든 경로가 보이도록 맞춘다.
  useEffect(() => {
    if (picking || !mapReady || allPoints.length === 0) return;
    mapRef.current?.fitToCoordinates(allPoints, {
      edgePadding: { top: 120, right: 50, bottom: 420, left: 50 },
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
    setTarget('start');
    setPicking(true);
    fitPair(a, b);
  };

  const cancelPicking = () => setPicking(false);

  const resetPicking = () => {
    setPickStart(null);
    setPickEnd(null);
    setTarget('start');
  };

  const applyPreset = (p: Preset) => {
    setPickStart(p.start);
    setPickEnd(p.end);
    setTarget('end');
    fitPair(p.start, p.end);
  };

  const onMapPress = (e: MapPressEvent) => {
    if (!picking) return;
    const c = e.nativeEvent.coordinate;
    const point = { latitude: c.latitude, longitude: c.longitude };
    if (target === 'start') {
      setPickStart(point);
      setTarget('end');
    } else {
      setPickEnd(point);
    }
  };

  const submitPick = async () => {
    if (!pickStart || !pickEnd || !check.ok || source.kind === 'loading') {
      return;
    }
    const ok = await loadRoutes(bodyFromPoints(pickStart, pickEnd));
    if (ok) setPicking(false);
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

  const custom = !isSameRequest(request, ROUTE_REQUEST);
  const sourceText =
    source.kind === 'loading'
      ? '경로 요청 중… (이전 결과 표시 중)'
      : source.kind === 'live'
        ? custom
          ? '서버에서 받은 경로 · 직접 고른 구간'
          : '서버에서 받은 경로'
        : source.kind === 'saved'
          ? `저장된 서버 응답 · 호출 실패(${source.reason}) · 눌러서 다시 요청`
          : `새 구간 요청 실패(${source.reason}) · 이전 결과를 보여주는 중 · 눌러서 다시 요청`;

  const serverText =
    server.state === 'checking'
      ? '서버 확인 중…'
      : server.state === 'ok'
        ? `서버 연결됨 · v${server.version}`
        : '서버 연결 안 됨 (눌러서 다시 확인)';
  const serverColor =
    server.state === 'ok'
      ? '#22C55E'
      : server.state === 'down'
        ? '#EF4444'
        : '#9CA3AF';

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
            onDragEnd={(e) => setPickStart(e.nativeEvent.coordinate)}
          />
        )}
        {picking && pickEnd && (
          <Marker
            coordinate={pickEnd}
            title="도착"
            pinColor="red"
            draggable
            onDragEnd={(e) => setPickEnd(e.nativeEvent.coordinate)}
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

      <View style={styles.topArea} pointerEvents="box-none">
        <Pressable
          style={styles.badge}
          onPress={() => loadRoutes(attempt)}
          disabled={source.kind === 'loading'}
        >
          {source.kind === 'loading' && (
            <ActivityIndicator size="small" color="#fff" />
          )}
          <Text style={styles.badgeText}>{sourceText}</Text>
        </Pressable>
        <Pressable style={styles.serverChip} onPress={checkServer}>
          <View style={[styles.serverDot, { backgroundColor: serverColor }]} />
          <Text style={styles.badgeText}>{serverText}</Text>
        </Pressable>
        {!picking && (
          <Pressable style={styles.changeBtn} onPress={startPicking}>
            <Text style={styles.badgeText}>출발·도착 바꾸기</Text>
          </Pressable>
        )}
      </View>

      {picking ? (
        <View style={styles.bottom}>
          <View style={styles.pickPanel}>
            <Text style={styles.pickTitle}>출발·도착 고르기</Text>
            <Text style={styles.pickHelp}>
              지도를 눌러 점을 찍고, 핀을 길게 눌러 끌면 옮길 수 있어요.
            </Text>
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
                  출발 찍기
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
                  도착 찍기
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
          </View>
        </View>
      ) : (
        <View style={styles.bottom}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cardRow}
          >
            {routes.map((r) => {
              const active = r.index === selected;
              const title =
                r.safety_rank != null
                  ? `${r.safety_rank}위 · ${r.route_id}`
                  : r.route_id;
              const guNames = (r.crime_risk_by_gu ?? [])
                .slice(0, 2)
                .map((g) => g.gu_name)
                .join('·');
              return (
                <Pressable
                  key={r.route_id}
                  onPress={() => setSelected(r.index)}
                  style={[
                    styles.card,
                    { borderColor: active ? r.color : 'transparent' },
                  ]}
                >
                  <View style={styles.cardHeader}>
                    <View style={[styles.dot, { backgroundColor: r.color }]} />
                    <Text style={styles.cardTitle}>{title}</Text>
                    <Text style={styles.cardDistance}>
                      {formatDistance(r.length_m)}
                    </Text>
                  </View>
                  <Text style={styles.cardScore}>
                    안전 참고점수 {formatScore(r.final_safety_score)}
                  </Text>
                  <Text style={styles.cardLine}>
                    시설 참고점수 {formatScore(r.facility_reference_score)}
                  </Text>
                  <Text style={styles.cardLine}>
                    지역 범죄 위험 {formatScore(r.crime_risk_score)}
                    {guNames ? ` (${guNames})` : ''}
                  </Text>
                  <Text style={styles.cardLine}>
                    CCTV {r.cctv_sites}곳 · 비상벨 {r.emergency_bell_sites}곳
                  </Text>
                  {/* 가로등은 데이터가 서울 전역을 덮지 못해 0이 "없음"을 뜻하지 않는다.
                      그래서 1곳 이상일 때만 '참고정보'로 보여주고 점수에는 쓰지 않는다. */}
                  {(r.streetlight_sites ?? 0) > 0 && (
                    <Text style={styles.cardNote}>
                      가로등 {r.streetlight_sites}곳 · 참고정보
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={styles.footnote}>
            안전 참고점수(임시 v1)는 공공데이터 기반 상대 비교값이며 실제 안전을
            보장하지 않아요. 지역 범죄 위험은 지나는 자치구 통계를 길이 비율로
            반영한 값이고, 높을수록 위험해요.
          </Text>
        </View>
      )}
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
    position: 'absolute',
    top: TOP_SPACE,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '92%',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  serverChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  serverDot: { width: 8, height: 8, borderRadius: 4 },
  changeBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: TAB_BAR_SPACE,
  },
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
    backgroundColor: 'rgba(0,0,0,0.6)',
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
  pickPanel: {
    marginHorizontal: 16,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
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
