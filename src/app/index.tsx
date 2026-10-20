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

// 서버가 안 될 때 대신 보여줄 '저장된 서버 응답'.
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

// ---- routes api (start) ----
const ROUTES_TIMEOUT_MS = 60000; // 서버가 도로망을 받아오느라 오래 걸릴 수 있어서 넉넉하게 60초

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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

// 백엔드(FastAPI) 주소.
// 방법 1) 앱 폴더에 .env.local 파일을 만들고 한 줄을 적는다 (코드를 고치지 않아도 된다)
//         EXPO_PUBLIC_SAFE_ROUTE_API_URL=http://PC의IP:8000
//         (적은 뒤에는 Expo 서버를 껐다 다시 켜야 반영된다)
// 방법 2) 파일이 없으면 아래 기본 주소를 쓴다. PC의 IP가 바뀌면 이 줄을 고치면 된다.
//         PowerShell에서 ipconfig → 'Wi-Fi' 항목의 IPv4 주소 + :8000
const API_BASE_URL =
  process.env.EXPO_PUBLIC_SAFE_ROUTE_API_URL || 'http://172.20.10.4:8000';

// 지금은 출발·도착을 고정해서 요청한다. (저장된 응답도 같은 좌표로 받은 것)
const ROUTE_REQUEST: RouteRequestBody = {
  start_lat: 37.5346,
  start_lon: 127.0005,
  end_lat: 37.5394,
  end_lon: 127.0062,
  candidate_count: 3,
};

const SAVED: RoutesResponse | null = isValidResponse(savedResponse)
  ? savedResponse
  : null;

type RouteSource =
  | { kind: 'loading' }
  | { kind: 'live' }
  | { kind: 'saved'; reason: string };

type ServerStatus =
  | { state: 'checking' }
  | { state: 'ok'; version: string }
  | { state: 'down' };

type LatLng = { latitude: number; longitude: number };

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

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
}

function formatScore(v: number | null | undefined): string {
  return v == null ? '-' : v.toFixed(1);
}

export default function HomeScreen() {
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [data, setData] = useState<RoutesResponse | null>(SAVED);
  const [source, setSource] = useState<RouteSource>({ kind: 'loading' });
  const [server, setServer] = useState<ServerStatus>({ state: 'checking' });

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

  // 백엔드 /routes 를 호출한다. 실패하면 저장된 서버 응답을 보여준다.
  const loadRoutes = useCallback(async () => {
    setSource({ kind: 'loading' });
    try {
      const live = await requestRoutes(
        API_BASE_URL,
        ROUTE_REQUEST,
        ROUTES_TIMEOUT_MS,
      );
      setData(live);
      setSelected(0);
      setSource({ kind: 'live' });
    } catch (e) {
      setData(SAVED);
      setSelected(0);
      setSource({ kind: 'saved', reason: errorReason(e) });
    }
  }, []);

  useEffect(() => {
    checkServer();
    loadRoutes();
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

  // 지도가 준비되었거나 경로가 바뀔 때마다 모든 경로가 보이도록 맞춘다.
  useEffect(() => {
    if (!mapReady || allPoints.length === 0) return;
    mapRef.current?.fitToCoordinates(allPoints, {
      edgePadding: { top: 120, right: 50, bottom: 420, left: 50 },
      animated: true,
    });
  }, [mapReady, allPoints]);

  if (routes.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>표시할 경로가 없어요.</Text>
        <Text style={styles.emptySub}>
          {source.kind === 'saved'
            ? `서버 호출 실패(${source.reason}) · 저장된 응답도 없어요`
            : '경로 요청 중…'}
        </Text>
        <Pressable
          onPress={loadRoutes}
          disabled={source.kind === 'loading'}
          style={styles.retry}
        >
          <Text style={styles.retryText}>다시 요청</Text>
        </Pressable>
      </View>
    );
  }

  const sourceText =
    source.kind === 'loading'
      ? '경로 요청 중… (저장된 응답 표시 중)'
      : source.kind === 'live'
        ? '서버에서 받은 경로'
        : `저장된 서버 응답 · 호출 실패(${source.reason}) · 눌러서 다시 요청`;

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
      >
        {drawOrder.map((r) => (
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
        <Marker coordinate={start} title="출발" pinColor="green" />
        <Marker coordinate={end} title="도착" pinColor="red" />
      </MapView>

      <View style={styles.topArea} pointerEvents="box-none">
        <Pressable
          style={styles.badge}
          onPress={loadRoutes}
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
      </View>

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
});