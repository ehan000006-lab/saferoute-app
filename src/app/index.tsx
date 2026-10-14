import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

// 지금은 백엔드 대신 샘플 응답(mock)을 읽는다.
// 나중에 POST /routes 응답으로 바꾸면 같은 구조라 아래 코드는 그대로 쓸 수 있다.
import mockResponse from '../../assets/mock_routes_response.json';

type RouteItem = {
  route_id: string;
  length_m: number;
  coordinates: [number, number][]; // [위도, 경도] 순서
  cctv_sites: number;
  emergency_bell_sites: number;
  facility_reference_score: number | null;
};

type RoutesResponse = {
  count: number;
  notice: string;
  routes: RouteItem[];
};

// 백엔드(FastAPI) 주소. PC의 IP가 바뀌면 이 줄만 고치면 된다.
// PowerShell에서 ipconfig → 'Wi-Fi' 항목의 IPv4 주소 + :8000
const API_BASE_URL = 'http://192.168.219.111:8000';

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

const data = mockResponse as unknown as RoutesResponse;

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

export default function HomeScreen() {
  const mapRef = useRef<MapView>(null);
  const [selected, setSelected] = useState(0);
  const [server, setServer] = useState<ServerStatus>({ state: 'checking' });

  // 백엔드 /health 를 호출해서 연결 상태를 확인한다. (5초 안에 응답이 없으면 실패 처리)
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

  useEffect(() => {
    checkServer();
  }, [checkServer]);

  const routes = useMemo<DrawnRoute[]>(
    () =>
      data.routes.map((r, i) => ({
        ...r,
        index: i,
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        path: toLatLng(r.coordinates),
      })),
    [],
  );

  const allPoints = useMemo(() => routes.flatMap((r) => r.path), [routes]);

  if (routes.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>표시할 경로가 없어요.</Text>
      </View>
    );
  }

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

  const fitAll = () => {
    mapRef.current?.fitToCoordinates(allPoints, {
      edgePadding: { top: 120, right: 50, bottom: 340, left: 50 },
      animated: true,
    });
  };

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
          latitude: start.latitude,
          longitude: start.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
        onMapReady={fitAll}
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
        <View style={styles.badge}>
          <Text style={styles.badgeText}>샘플 데이터 · 실제 경로 아님</Text>
        </View>
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
            // 가로등은 데이터가 서울 전역을 덮지 못해 0이 "없음"을 뜻하지 않으므로 화면에 표시하지 않는다.
            const score =
              r.facility_reference_score != null
                ? r.facility_reference_score.toFixed(1)
                : '-';
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
                  <Text style={styles.cardTitle}>{r.route_id}</Text>
                  <Text style={styles.cardDistance}>
                    {formatDistance(r.length_m)}
                  </Text>
                </View>
                <Text style={styles.cardLine}>CCTV {r.cctv_sites}곳</Text>
                <Text style={styles.cardLine}>
                  비상벨 {r.emergency_bell_sites}곳
                </Text>
                <Text style={styles.cardScore}>시설 참고점수 {score}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Text style={styles.footnote}>
          시설 참고점수는 CCTV·비상벨 분포를 기준으로 한 참고 지표이며, 실제
          안전을 보장하지 않아요.
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
  },
  emptyText: { color: '#fff' },
  topArea: {
    position: 'absolute',
    top: TOP_SPACE,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 6,
  },
  badge: {
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
    width: 168,
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
  cardLine: { color: '#222', fontSize: 13 },
  cardScore: { color: '#111', fontSize: 13, fontWeight: '600', marginTop: 2 },
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