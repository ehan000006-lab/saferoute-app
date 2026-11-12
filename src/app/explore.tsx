import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PALETTE = { navy: '#143248', teal: '#178D83', gray: '#64748B', bg: '#F5F8FA' };

function InfoCard({ title, children }: { title: string; children: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardBody}>{children}</Text>
    </View>
  );
}

export default function MethodGuideScreen() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 185 }]}>
      <Text style={styles.kicker}>SafeRoute · 방법론 안내</Text>
      <Text style={styles.title}>경로 점수는 어떻게 계산할까요?</Text>
      <Text style={styles.intro}>공공데이터를 바탕으로 후보 경로의 시설 환경과 지역별 참고지표를 비교합니다. 범죄 발생 가능성을 예측하는 점수는 아닙니다.</Text>
      <View style={styles.formulaBox}>
        <Text style={styles.formulaTitle}>잠정 안전환경 참고점수</Text>
        <Text style={styles.formula}>55% 시설 + 40% 범죄 안전 + 5% 안심귀갓길</Text>
        <Text style={styles.formulaNote}>기존 기준: CCTV 30.94% · 비상벨 24.06% · 범죄 40% · 안심귀갓길 5%. 0~100점 상대 비교값.</Text>
      </View>
      <InfoCard title="CCTV 가중치 실험 (3차 통합본)">지도 화면에서 현재 기준(30.94%), CCTV 절반(15.47%), CCTV 제외(0%)를 선택하면 동일한 후보 R1~R3의 점수와 순위를 즉시 비교할 수 있습니다. CCTV를 줄인 비중은 다른 세 항목에 기존 비율대로 재분배합니다. 비교표 보기에서 세 모델을 한 번에 확인할 수 있습니다. 점수의 실험적 민감도를 분석하는 기능이며, 어떤 비율이 실제로 더 안전한지는 검증하지 못합니다.</InfoCard>
      <InfoCard title="시설 참고점수" >CCTV와 비상벨의 경로 주변 50m 지점 수를 길이로 정규화하고, 기준 구간의 분포에 따라 점수화합니다.</InfoCard>
      <InfoCard title="지역 범죄 안전점수" >2024년 자치구별 5대 범죄와 2025년 10월 주민등록인구를 결합한 참고 위험값을 사용하며, 경로가 통과하는 구간 길이 비율을 반영합니다. 위험 참고값은 낮을수록 유리합니다.</InfoCard>
      <InfoCard title="안심귀갓길·가로등" >지정 안심귀갓길과 경로의 근접 구간을 참고합니다. 가로등 위치는 지역별 자료 범위가 불균등해 점수에서 제외하고 수량만 참고로 보여줍니다.</InfoCard>
      <InfoCard title="장소 검색과 경로 추천">지하철역·가게·건물명 검색 결과에서 장소 좌표를 선택하면 기존 보행 경로 탐색과 안전 참고점수 계산을 요청합니다. 지도에서 직접 선택하는 방식도 유지합니다. 이름 일치도·서울 지역·지도 중심과의 거리를 기준으로 검색 결과를 재정렬합니다.</InfoCard>
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>꼭 알아두세요</Text>
        <Text style={styles.warningText}>• 시설이 많이 등록돼 있다고 해당 장소의 실제 안전이 보장되는 것은 아닙니다.</Text>
        <Text style={styles.warningText}>• 범죄 참고값은 자치구 단위 통계로 개별 골목을 평가하지 않습니다.</Text>
        <Text style={styles.warningText}>• 보행 중에는 주변 상황을 직접 확인하고 공식 안내를 우선해 주세요.</Text>
      </View>
      <Text style={styles.caption}>점수 기준: 기존 v1 잠정 유지 · 실험 모드 v1 · 백엔드 v0.6 preview · 생활인구 점수 제외</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: PALETTE.bg, flex: 1 },
  content: { paddingHorizontal: 18, gap: 13 },
  kicker: { color: PALETTE.teal, fontSize: 12, fontWeight: '700' },
  title: { color: PALETTE.navy, fontSize: 24, fontWeight: '800', marginTop: 4 },
  intro: { color: '#475569', fontSize: 14, lineHeight: 23 },
  formulaBox: { backgroundColor: '#E1F3F0', padding: 18, borderRadius: 15, gap: 8 },
  formulaTitle: { color: '#126A63', fontSize: 13, fontWeight: '800' },
  formula: { color: PALETTE.navy, fontSize: 16, fontWeight: '800', lineHeight: 25 },
  formulaNote: { color: '#466C70', fontSize: 12 },
  card: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 14, padding: 16, gap: 7 },
  cardTitle: { color: PALETTE.navy, fontSize: 15, fontWeight: '800' },
  cardBody: { color: '#475569', fontSize: 13, lineHeight: 21 },
  warningBox: { backgroundColor: '#FFF4E9', borderRadius: 14, padding: 16, gap: 6 },
  warningTitle: { color: '#8C5119', fontSize: 14, fontWeight: '800' },
  warningText: { color: '#7A572F', fontSize: 12, lineHeight: 20 },
  caption: { color: PALETTE.gray, fontSize: 11, textAlign: 'center', marginTop: 8 },
});
