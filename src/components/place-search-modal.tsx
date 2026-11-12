import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type PlaceResult = {
  id: string;
  name: string;
  address: string;
  category: string;
  latitude: number;
  longitude: number;
};

type Props = {
  visible: boolean;
  target: 'start' | 'end';
  apiBaseUrl: string;
  center?: { latitude: number; longitude: number } | null;
  onSelect: (place: PlaceResult) => void;
  onClose: () => void;
};

type SearchResponse = { provider: 'kakao'; places: PlaceResult[] };

function isPlace(x: unknown): x is PlaceResult {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.name === 'string' &&
    typeof obj.address === 'string' && typeof obj.category === 'string' &&
    typeof obj.latitude === 'number' && Number.isFinite(obj.latitude) &&
    typeof obj.longitude === 'number' && Number.isFinite(obj.longitude);
}

export default function PlaceSearchModal({ visible, target, apiBaseUrl, center, onSelect, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('가게명, 역 이름, 건물명으로 검색해 보세요.');
  const inputRef = useRef<TextInput>(null);

  // Reset between start/end searches, including pending requests (aborted below).
  useEffect(() => {
    if (visible) {
      setQuery('');
      setPlaces([]);
      setBusy(false);
      setMessage('가게명, 역 이름, 건물명으로 검색해 보세요.');
    }
  }, [visible, target]);

  useEffect(() => {
    if (!visible) return;
    const keyword = query.trim();
    if (keyword.length < 2) {
      setBusy(false);
      setPlaces([]);
      setMessage(keyword.length ? '검색어를 두 글자 이상 입력해 주세요.' : '예: 안국역, 서울역, 스타벅스');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      setMessage('');
      try {
        // encodeURIComponent keeps Korean search terms safe without relying on
        // URLSearchParams platform polyfills in different native runtimes.
        let url = `${apiBaseUrl}/places/search?query=${encodeURIComponent(keyword)}`;
        if (center && Number.isFinite(center.latitude) && Number.isFinite(center.longitude)) {
          url += `&lat=${center.latitude}&lon=${center.longitude}`;
        }
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          let detail = '';
          try {
            const errorBody: unknown = await res.json();
            if (errorBody && typeof errorBody === 'object' && 'detail' in errorBody) {
              const value = (errorBody as { detail: unknown }).detail;
              if (typeof value === 'string') detail = value;
            }
          } catch { /* Some proxies return non-JSON errors. */ }
          throw new Error(detail || `검색 서버 오류 (HTTP ${res.status})`);
        }
        const data: unknown = await res.json();
        const list = data && typeof data === 'object' && 'places' in data &&
          Array.isArray((data as SearchResponse).places) ? (data as SearchResponse).places : null;
        if (!list || !list.every(isPlace)) throw new Error('검색 결과 형식을 확인할 수 없습니다.');
        if (!controller.signal.aborted) {
          setPlaces(list);
          setMessage(list.length ? '' : '검색 결과가 없어요. 다른 장소명을 입력하거나 지도에서 직접 선택해 주세요.');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setPlaces([]);
          const reason = e instanceof Error ? e.message : '알 수 없는 오류';
          setMessage(reason === 'Network request failed'
            ? '백엔드에 연결할 수 없습니다. PC IP·Wi-Fi·서버 실행을 확인해 주세요.' : reason);
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, visible, target, apiBaseUrl, center?.latitude, center?.longitude]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.container, { paddingTop: insets.top + 16, paddingBottom: Math.max(insets.bottom, 16) }] }>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>SafeRoute · 장소 찾기</Text>
              <Text style={styles.title}>{target === 'start' ? '출발지 검색' : '도착지 검색'}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>닫기</Text>
            </Pressable>
          </View>
          <View style={styles.inputFrame}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput
              ref={inputRef}
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder="가게명 · 지하철역 · 건물명 검색"
              placeholderTextColor="#94A3B8"
              returnKeyType="search"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="장소 검색어"
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="검색어 지우기">
                <Text style={styles.clear}>×</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.info}>검색 결과는 카카오 로컬 API 제공 정보이며, 선택한 좌표로 경로를 계산합니다.</Text>
          {busy && <View style={styles.loading}><ActivityIndicator color="#2563EB" /><Text style={styles.muted}>검색 중…</Text></View>}
          {!busy && !!message && <View style={styles.message}><Text style={styles.messageText}>{message}</Text></View>}
          <FlatList
            style={styles.list}
            data={places}
            keyboardShouldPersistTaps="always"
            keyExtractor={(place) => place.id}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onSelect(item)}
                style={({ pressed }) => [styles.item, pressed && { backgroundColor: '#EFF6FF' }]}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.address}, 선택`}
              >
                <View style={styles.marker}><Text style={{ color: '#2563EB', fontWeight: '800' }}>⌖</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.placeName}>{item.name}</Text>
                  {!!item.category && <Text style={styles.category} numberOfLines={1}>{item.category}</Text>}
                  <Text style={styles.address} numberOfLines={2}>{item.address}</Text>
                </View>
                <Text style={styles.choose}>선택</Text>
              </Pressable>
            )}
          />
          <Pressable style={styles.mapButton} onPress={onClose} accessibilityRole="button">
            <Text style={styles.mapButtonText}>검색 대신 지도에서 직접 선택하기</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, paddingHorizontal: 20, backgroundColor: '#F5F8FA' },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 12 },
  eyebrow: { fontSize: 12, fontWeight: '700', color: '#14847C', marginBottom: 5 },
  title: { fontSize: 26, fontWeight: '800', color: '#143248' },
  close: { backgroundColor: '#E6EDF2', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12 },
  closeText: { fontWeight: '700', color: '#475569' },
  inputFrame: { backgroundColor: '#FFFFFF', borderRadius: 15, borderWidth: 1, borderColor: '#BED0DD', paddingHorizontal: 15, height: 54, flexDirection: 'row', alignItems: 'center', gap: 9 },
  searchIcon: { fontSize: 26, color: '#64748B', lineHeight: 30 },
  input: { flex: 1, fontSize: 15, color: '#1E293B', paddingVertical: 0 },
  clear: { fontSize: 23, paddingHorizontal: 6, color: '#64748B' },
  info: { marginTop: 10, marginBottom: 14, color: '#64748B', fontSize: 12, lineHeight: 18 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 18 },
  muted: { color: '#64748B', fontSize: 13 },
  message: { padding: 16, borderRadius: 12, backgroundColor: '#EAF0F5' },
  messageText: { fontSize: 13, color: '#475569', lineHeight: 21 },
  list: { flex: 1, marginTop: 5 },
  item: { paddingVertical: 15, flexDirection: 'row', alignItems: 'center', gap: 12 },
  separator: { height: 1, backgroundColor: '#E1E8EF' },
  marker: { height: 38, width: 38, borderRadius: 13, backgroundColor: '#E5F0FF', alignItems: 'center', justifyContent: 'center' },
  placeName: { fontWeight: '800', fontSize: 15, color: '#17324C' },
  category: { color: '#64748B', fontSize: 11, marginTop: 3 },
  address: { color: '#475569', fontSize: 12, marginTop: 5, lineHeight: 18 },
  choose: { color: '#2563EB', fontWeight: '700', fontSize: 12 },
  mapButton: { backgroundColor: '#DBEAFE', paddingVertical: 15, borderRadius: 14, alignItems: 'center' },
  mapButtonText: { color: '#1D4ED8', fontWeight: '800', fontSize: 13 },
});
