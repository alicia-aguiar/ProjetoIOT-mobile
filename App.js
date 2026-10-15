import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL || "http://10.137.11.6").replace(/\/$/, "");
const SENSORS_PATH = process.env.EXPO_PUBLIC_SENSORS_PATH || "/api/sensor/status/listar";
const SENSOR_DETAILS_PATH = process.env.EXPO_PUBLIC_SENSOR_DETAILS_PATH || "/api/sensor/status/visualizar/:id";
const STATUS_PATH_TEMPLATE = process.env.EXPO_PUBLIC_SENSOR_STATUS_PATH || "/api/sensor/status/atualizar";
const STATUS_METHOD = (process.env.EXPO_PUBLIC_STATUS_METHOD || "PUT").toUpperCase();
function fieldOrDefault(configuredValue, defaultValue) {
  const value = configuredValue?.trim();
  return !value || value.startsWith("CONFIRMAR_")
    ? defaultValue
    : value;
}
const STATUS_ID_FIELD = fieldOrDefault(process.env.EXPO_PUBLIC_STATUS_ID_FIELD, "codigo");
const STATUS_FIELD = fieldOrDefault(process.env.EXPO_PUBLIC_STATUS_FIELD, "status");

function getSensorId(sensor) {
  const value = sensor?.codigo ?? sensor?.id ?? sensor?._id ?? sensor?.sensorId ?? sensor?.sensor_id;
  return value == null ? "" : String(value);
}

function getSensorName(sensor) {
  const value = sensor?.tipo ?? sensor?.name ?? sensor?.nome ?? sensor?.label ?? sensor?.sensorName;
  return value == null || value === "" ? `Sensor ${getSensorId(sensor) || "sem nome"}` : String(value);
}

function getSensorStatus(sensor) {
  const value = sensor?.status ?? sensor?.estado ?? sensor?.state;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return value == null || value === "" ? "Não informado" : String(value);
}

function displayStatus(status) {
  if (status === true) return "Ativo";
  if (status === false) return "Inativo";
  return String(status ?? "Não informado");
}

function normalizeSensor(sensor) {
  if (!sensor || typeof sensor !== "object") return null;
  const id = getSensorId(sensor);
  if (!id) return null;
  return { ...sensor, id, name: getSensorName(sensor), status: getSensorStatus(sensor) };
}

function extractSensorArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["data", "sensors", "sensores", "results", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

function apiConfigurationError() {
  const missing = [];
  if (!API_BASE_URL) missing.push("EXPO_PUBLIC_API_URL");
  if (!SENSORS_PATH) missing.push("EXPO_PUBLIC_SENSORS_PATH");
  return missing.length
    ? `Configure no arquivo .env: ${missing.join(", ")}. Veja o arquivo INTEGRACAO.md.`
    : "";
}

async function apiRequest(path, options = {}) {
  const configError = apiConfigurationError();
  if (configError) throw new Error(configError);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Não foi possível conectar ao backend. Verifique a URL e a rede.");
  }

  const responseText = response.status === 204 ? "" : await response.text();
  let payload;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = responseText;
    }
  }

  if (!response.ok) {
    const serverMessage =
      payload && typeof payload === "object"
        ? payload.message || payload.error || payload.detail
        : payload;
    throw new Error(serverMessage ? String(serverMessage) : `Erro HTTP ${response.status}.`);
  }

  return payload;
}

async function fetchSensorStatusById(sensorId) {
  // A rota de visualização enviada usa o código do sensor no fim do caminho.
  const path = SENSOR_DETAILS_PATH
    .replaceAll(":id", encodeURIComponent(String(sensorId).toLowerCase()))
    .replaceAll("{id}", encodeURIComponent(String(sensorId).toLowerCase()));
  const payload = await apiRequest(path);
  const candidate = payload?.sensor ?? payload?.data ?? payload;
  if (!candidate || typeof candidate !== "object" || candidate.status === undefined) {
    throw new Error(`A resposta de visualização do sensor ${sensorId} não contém o campo status.`);
  }
  const value = candidate.status;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return value;
}

async function fetchSensors() {
  const payload = await apiRequest(SENSORS_PATH);
  const rows = extractSensorArray(payload);
  if (!rows) {
    throw new Error(
      "A resposta da listagem não contém um array reconhecido. Ajuste extractSensorArray() ao formato real da API."
    );
  }
  const listedSensors = rows.map(normalizeSensor).filter(Boolean);
  const latestStatuses = new Array(listedSensors.length);
  let nextIndex = 0;
  const workerCount = Math.min(5, listedSensors.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < listedSensors.length) {
      const index = nextIndex++;
      try {
        latestStatuses[index] = { status: await fetchSensorStatusById(listedSensors[index].id) };
      } catch {
        // Mantém o status vindo da listagem se a consulta individual falhar.
        latestStatuses[index] = { failed: true };
      }
    }
  }));

  return listedSensors.map((sensor, index) => latestStatuses[index]?.failed
    ? { ...sensor, statusFromList: true }
    : { ...sensor, status: latestStatuses[index]?.status, statusFromList: false }
  );
}

function buildStatusPath(sensorId) {
  if (!STATUS_PATH_TEMPLATE) {
    throw new Error("Configure EXPO_PUBLIC_SENSOR_STATUS_PATH com a rota real de atualização.");
  }
  if (!STATUS_METHOD) {
    throw new Error("Configure EXPO_PUBLIC_STATUS_METHOD com o método HTTP real (por exemplo, PATCH ou PUT)." );
  }
  return STATUS_PATH_TEMPLATE
    .replaceAll(":id", encodeURIComponent(sensorId))
    .replaceAll("{id}", encodeURIComponent(sensorId));
}

async function saveSensorStatus(sensorId, status) {
  const path = buildStatusPath(sensorId);
  const payload = await apiRequest(path, {
    method: STATUS_METHOD,
    body: JSON.stringify({ [STATUS_ID_FIELD]: sensorId, [STATUS_FIELD]: status }),
  });

  // Se a rota devolver o sensor atualizado, aproveitamos o dado confirmado pelo servidor.
  const candidate = payload?.sensor ?? payload?.data ?? payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const normalized = normalizeSensor(candidate);
    if (normalized && normalized.id === sensorId) return normalized;
  }
  return null;
}

export default function App() {
  const [sensors, setSensors] = useState([]);
  const [search, setSearch] = useState("");
  const [remoteSearchSensor, setRemoteSearchSensor] = useState(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [error, setError] = useState("");

  const loadSensors = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      setSensors(await fetchSensors());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar os sensores.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadSensors();
  }, [loadSensors]);

  const visibleSensors = useMemo(() => {
    if (remoteSearchSensor) return [remoteSearchSensor];
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sensors;
    return sensors.filter((sensor) =>
      `${sensor.name} ${sensor.id}`.toLocaleLowerCase().includes(query)
    );
  }, [sensors, search, remoteSearchSensor]);

  const sensorTotals = useMemo(() => ({
    total: sensors.length,
    active: sensors.filter((sensor) => sensor.status === true).length,
    inactive: sensors.filter((sensor) => sensor.status === false).length,
  }), [sensors]);

  async function handleSearchById() {
    const query = search.trim();
    if (!query) {
      setRemoteSearchSensor(null);
      return;
    }
    // A rota de visualização recebe um ID. A pesquisa por nome permanece local.
    const isKnownId = sensors.some((sensor) => sensor.id.toLocaleLowerCase() === query.toLocaleLowerCase());
    if (!isKnownId) return;

    setSearching(true);
    setError("");
    try {
      const status = await fetchSensorStatusById(query);
      const listedSensor = sensors.find((sensor) => sensor.id.toLocaleLowerCase() === query.toLocaleLowerCase());
      setRemoteSearchSensor({ ...listedSensor, status, statusFromList: false });
    } catch (err) {
      setRemoteSearchSensor(null);
      setError(err instanceof Error ? err.message : "Não foi possível visualizar esse sensor.");
    } finally {
      setSearching(false);
    }
  }

  async function handleStatusUpdate(sensor, newStatus) {
    setUpdatingId(sensor.id);
    setError("");
    try {
      const updatedSensor = await saveSensorStatus(sensor.id, newStatus);
      if (updatedSensor) {
        setSensors((current) => current.map((item) => item.id === sensor.id ? updatedSensor : item));
        setRemoteSearchSensor((current) => current?.id === sensor.id ? updatedSensor : current);
      } else {
        // A rota PUT confirma a operação; a rota GET individual confirma o valor salvo.
        const savedStatus = await fetchSensorStatusById(sensor.id);
        setSensors((current) => current.map((item) => item.id === sensor.id
          ? { ...item, status: savedStatus, statusFromList: false }
          : item
        ));
        setRemoteSearchSensor((current) => current?.id === sensor.id
          ? { ...current, status: savedStatus, statusFromList: false }
          : current
        );
      }
      Alert.alert("Atualização concluída", `Sensor definido como ${displayStatus(newStatus)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível atualizar o status.");
    } finally {
      setUpdatingId(null);
    }
  }

  function renderSensor({ item }) {
    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <View style={styles.sensorIcon}><Text style={styles.sensorIconText}>S</Text></View>
          <View style={styles.sensorHeading}>
            <Text style={styles.sensorName}>{item.name}</Text>
            <Text style={styles.sensorId}>ID: {item.id}</Text>
          </View>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Status atual</Text>
          <Text style={styles.statusValue}>{displayStatus(item.status)}{item.statusFromList ? " (lista)" : ""}</Text>
        </View>
        <Text style={styles.updateLabel}>Definir status deste sensor</Text>
        <View style={styles.toggleActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Definir status do sensor ${item.id} como Ativo`}
            style={[styles.stateButton, item.status === true && styles.trueSelected, updatingId === item.id && styles.disabledButton]}
            disabled={updatingId === item.id || item.status === true}
            onPress={() => void handleStatusUpdate(item, true)}
          >
            {updatingId === item.id ? <ActivityIndicator color="#FFFFFF" /> : <Text style={[styles.stateButtonText, item.status === true && styles.selectedButtonText]}>Ativo</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Definir status do sensor ${item.id} como Inativo`}
            style={[styles.stateButton, item.status === false && styles.falseSelected, updatingId === item.id && styles.disabledButton]}
            disabled={updatingId === item.id || item.status === false}
            onPress={() => void handleStatusUpdate(item, false)}
          >
            {updatingId === item.id ? <ActivityIndicator color="#FFFFFF" /> : <Text style={[styles.stateButtonText, item.status === false && styles.selectedButtonText]}>Inativo</Text>}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#F4F7FB" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>PAINEL DE MONITORAMENTO</Text>
          <Text style={styles.title}>Sensores</Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          style={styles.reloadButton}
          onPress={() => void loadSensors(true)}
          disabled={loading || refreshing}
        >
          <Text style={styles.reloadText}>{refreshing ? "Atualizando..." : "Recarregar"}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Text style={styles.searchGlyph}>⌕</Text>
        <TextInput
          accessibilityLabel="Pesquisar sensores"
          style={styles.searchInput}
          placeholder="Pesquisar por nome ou ID"
          placeholderTextColor="#8290A5"
          value={search}
          onChangeText={(value) => { setSearch(value); setRemoteSearchSensor(null); }}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onSubmitEditing={() => void handleSearchById()}
        />
        <TouchableOpacity accessibilityRole="button" onPress={() => void handleSearchById()} disabled={searching} style={styles.searchButton}>
          {searching ? <ActivityIndicator size="small" color="#3157C9" /> : <Text style={styles.searchButtonText}>Buscar</Text>}
        </TouchableOpacity>
      </View>

      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Sensores</Text>
          <Text style={styles.summaryValue}>{sensorTotals.total}</Text>
          <Text style={styles.summaryCaption}>Total</Text>
        </View>
        <View style={[styles.summaryCard, styles.summaryCardMiddle]}>
          <Text style={styles.summaryLabel}>Ativos</Text>
          <Text style={[styles.summaryValue, styles.activeValue]}>{sensorTotals.active}</Text>
          <Text style={styles.summaryCaption}>Status ativo</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Inativos</Text>
          <Text style={[styles.summaryValue, styles.inactiveValue]}>{sensorTotals.inactive}</Text>
          <Text style={styles.summaryCaption}>Status inativo</Text>
        </View>
      </View>

      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Algo deu errado</Text>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => void loadSensors()} style={styles.retryButton}>
            <Text style={styles.retryText}>Tentar novamente</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#3157C9" />
          <Text style={styles.helper}>Carregando sensores...</Text>
        </View>
      ) : (
        <FlatList
          data={visibleSensors}
          keyExtractor={(item) => item.id}
          renderItem={renderSensor}
          refreshing={refreshing}
          onRefresh={() => void loadSensors(true)}
          contentContainerStyle={visibleSensors.length ? styles.list : styles.emptyList}
          ListEmptyComponent={(
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>{search.trim() ? "Nenhum sensor encontrado" : "Nenhum sensor cadastrado"}</Text>
              <Text style={styles.helper}>{search.trim() ? "Tente outro nome ou identificador." : "Os sensores aparecerão aqui quando forem carregados."}</Text>
            </View>
          )}
          ListHeaderComponent={visibleSensors.length > 0 ? <Text style={styles.count}>{visibleSensors.length} {visibleSensors.length === 1 ? "sensor" : "sensores"}{search.trim() ? " encontrados" : " disponíveis"}</Text> : null}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F4F7FB" },
  header: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { color: "#65728A", fontSize: 10, fontWeight: "800", letterSpacing: 1.1 },
  title: { color: "#172033", fontSize: 30, fontWeight: "800", marginTop: 4 },
  reloadButton: { backgroundColor: "#E8EEFF", paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10 },
  reloadText: { color: "#3157C9", fontWeight: "700", fontSize: 13 },
  searchWrap: { marginHorizontal: 20, marginBottom: 8, flexDirection: "row", alignItems: "center", borderRadius: 13, borderWidth: 1, borderColor: "#DCE3EF", backgroundColor: "#FFFFFF", paddingHorizontal: 13 },
  searchGlyph: { color: "#65728A", fontSize: 25, marginRight: 7 },
  searchInput: { flex: 1, paddingVertical: 13, color: "#172033", fontSize: 15 },
  searchButton: { marginLeft: 8, paddingVertical: 9, paddingHorizontal: 8 },
  searchButtonText: { color: "#3157C9", fontWeight: "700", fontSize: 13 },
  summaryRow: { flexDirection: "row", paddingHorizontal: 20, marginTop: 4, marginBottom: 8 },
  summaryCard: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 13, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E3E9F2" },
  summaryCardMiddle: { marginHorizontal: 8 },
  summaryLabel: { color: "#65728A", fontSize: 11, fontWeight: "700" },
  summaryValue: { color: "#172033", fontSize: 23, fontWeight: "800", marginTop: 4 },
  activeValue: { color: "#15803D" },
  inactiveValue: { color: "#B42318" },
  summaryCaption: { color: "#8290A5", fontSize: 9, marginTop: 2 },
  list: { paddingHorizontal: 20, paddingBottom: 28 },
  emptyList: { flexGrow: 1, paddingHorizontal: 20 },
  count: { color: "#65728A", fontSize: 13, fontWeight: "600", marginTop: 13, marginBottom: 4 },
  card: { marginTop: 12, padding: 16, backgroundColor: "#FFFFFF", borderRadius: 16, borderWidth: 1, borderColor: "#E3E9F2", shadowColor: "#1C2A46", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  cardTop: { flexDirection: "row", alignItems: "center" },
  sensorIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#EAF0FF", alignItems: "center", justifyContent: "center" },
  sensorIconText: { color: "#3157C9", fontWeight: "800", fontSize: 18 },
  sensorHeading: { flex: 1, marginLeft: 12 },
  sensorName: { color: "#172033", fontWeight: "700", fontSize: 17 },
  sensorId: { color: "#738098", fontSize: 12, marginTop: 3 },
  statusRow: { marginTop: 16, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#F6F8FC", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statusLabel: { color: "#65728A", fontSize: 13 },
  statusValue: { color: "#172033", fontSize: 13, fontWeight: "700", maxWidth: "60%", textAlign: "right" },
  updateLabel: { marginTop: 13, marginBottom: 8, color: "#65728A", fontSize: 12, fontWeight: "600" },
  toggleActions: { flexDirection: "row" },
  stateButton: { flex: 1, marginRight: 8, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1, borderColor: "#DCE3EF", backgroundColor: "#FFFFFF" },
  trueSelected: { borderColor: "#15803D", backgroundColor: "#15803D" },
  falseSelected: { borderColor: "#B42318", backgroundColor: "#B42318" },
  stateButtonText: { color: "#344054", fontWeight: "700", fontSize: 14 },
  selectedButtonText: { color: "#FFFFFF" },
  disabledButton: { opacity: 0.65 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyState: { alignItems: "center", justifyContent: "center", flex: 1, padding: 25 },
  emptyTitle: { color: "#172033", fontSize: 19, fontWeight: "700", textAlign: "center" },
  helper: { marginTop: 8, color: "#65728A", textAlign: "center", fontSize: 14, lineHeight: 20 },
  errorBox: { marginHorizontal: 20, marginTop: 8, padding: 14, borderRadius: 12, backgroundColor: "#FFF0F0", borderWidth: 1, borderColor: "#F2D0D0" },
  errorTitle: { color: "#982E2E", fontWeight: "700", marginBottom: 4 },
  errorText: { color: "#842D2D", fontSize: 13, lineHeight: 18 },
  retryButton: { alignSelf: "flex-start", paddingTop: 10 },
  retryText: { color: "#3157C9", fontWeight: "700" },
});
