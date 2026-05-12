// Mappatura codice Siacloud → descrizione negozio (regione, città, nome).
// Usata per: (1) mostrare al cliente in che negozio c'è disponibilità,
// (2) abbinare il codice Siacloud al record in stores.json (per indirizzo/orari).
// Fonte: dump fornito da Zuiki il 2026-05-11.

export interface SiacloudStore {
  code: string;
  region: string;
  province: string;
  name: string; // es. "C.C. Le Porte Franche"
}

export const SIACLOUD_STORES: SiacloudStore[] = [
  // ABRUZZO
  { code: 'MEGAL', region: 'Abruzzo', province: 'Chieti', name: 'C.C. Megalò' },
  { code: 'PNORD', region: 'Abruzzo', province: 'Pescara', name: 'C.C. Pescara Nord' },
  { code: 'PE', region: 'Abruzzo', province: 'Pescara', name: 'Pescara C.S.' },
  { code: 'SASSO', region: 'Abruzzo', province: 'Teramo', name: 'C.C. Gran Sasso' },
  { code: 'VALVI', region: 'Abruzzo', province: 'Teramo', name: 'C.C. Val Vibrata' },
  // BASILICATA
  { code: 'HERAC', region: 'Basilicata', province: 'Matera', name: 'C.C. Heraclea' },
  // CALABRIA
  { code: 'CORI', region: 'Calabria', province: 'Cosenza', name: 'C.C. I Portali' },
  { code: 'BEL03', region: 'Calabria', province: 'Cosenza', name: 'C.C. Il Tirreno' },
  { code: 'EDNER', region: 'Calabria', province: 'Cosenza', name: 'C.C. Metropolis' },
  { code: 'COSEN', region: 'Calabria', province: 'Cosenza', name: 'Cosenza C.S.' },
  { code: '2MARI', region: 'Calabria', province: 'Catanzaro', name: 'C.C. Due Mari' },
  { code: 'CZ02', region: 'Calabria', province: 'Catanzaro', name: 'C.C. Le Fontane' },
  { code: 'KR', region: 'Calabria', province: 'Crotone', name: 'C.C. Le Spighe' },
  { code: 'STRET', region: 'Calabria', province: 'Reggio Calabria', name: 'Porto Bolaro Shopping Center' },
  { code: 'LAGRU', region: 'Calabria', province: 'Reggio Calabria', name: 'C.C. La Gru' },
  { code: 'VIBOO', region: 'Calabria', province: 'Vibo Valentia', name: 'C.C. Vibo Center' },
  // CAMPANIA
  { code: 'DORA', region: 'Campania', province: 'Avellino', name: 'Avellino C.S.' },
  { code: 'MIRA', region: 'Campania', province: 'Avellino', name: 'C.C. Il Carro' },
  { code: 'BUONV', region: 'Campania', province: 'Benevento', name: 'C.C. Buonvento' },
  { code: 'APO02', region: 'Campania', province: 'Caserta', name: 'C.C. Apollo' },
  { code: 'MARC', region: 'Campania', province: 'Caserta', name: 'C.C. Campania' },
  { code: 'JAMB1', region: 'Campania', province: 'Caserta', name: 'C.C. Jambo1' },
  { code: 'VOMER', region: 'Campania', province: 'Napoli', name: 'Napoli C.S. (Vomero)' },
  { code: 'GARIB', region: 'Campania', province: 'Napoli', name: 'Napoli C.S. (Garibaldi)' },
  { code: 'UMBER', region: 'Campania', province: 'Napoli', name: 'Napoli C.S. (Umberto)' },
  { code: 'TOLED', region: 'Campania', province: 'Napoli', name: 'Napoli C.S. (Toledo)' },
  { code: 'PORTI', region: 'Campania', province: 'Napoli', name: 'Portici C.S.' },
  { code: 'SORRE', region: 'Campania', province: 'Napoli', name: 'Sorrento C.S.' },
  { code: 'TORRE', region: 'Campania', province: 'Napoli', name: 'Torre del Greco C.S.' },
  { code: 'CART', region: 'Campania', province: 'Napoli', name: 'C.C. La Cartiera' },
  { code: 'NEAPO', region: 'Campania', province: 'Napoli', name: 'C.C. Neapolis' },
  { code: 'QUART', region: 'Campania', province: 'Napoli', name: 'C.C. Quarto Nuovo' },
  { code: 'VESUV', region: 'Campania', province: 'Napoli', name: 'C.C. Vulcano Buono' },
  { code: 'GIUGL', region: 'Campania', province: 'Napoli', name: 'Parco Commerciale Grande Sud' },
  { code: 'STABI', region: 'Campania', province: 'Napoli', name: 'Castellammare C.S.' },
  { code: 'LEBOL', region: 'Campania', province: 'Salerno', name: 'C.C. Le Bolle' },
  { code: 'SALER', region: 'Campania', province: 'Salerno', name: 'C.C. Le Cotoniere' },
  { code: 'SAPRI', region: 'Campania', province: 'Salerno', name: 'C.C. Le Ginestre' },
  { code: 'MAXI', region: 'Campania', province: 'Salerno', name: 'C.C. Maximall' },
  // EMILIA-ROMAGNA
  { code: 'NOVA', region: 'Emilia-Romagna', province: 'Bologna', name: 'C.C. Centronova' },
  { code: 'FORLI', region: 'Emilia-Romagna', province: 'Forlì-Cesena', name: 'C.C. Punta di ferro' },
  { code: 'ROTON', region: 'Emilia-Romagna', province: 'Modena', name: 'C.C. La Rotonda' },
  { code: 'PARMA', region: 'Emilia-Romagna', province: 'Parma', name: 'C.C. Eurosia' },
  { code: 'PR', region: 'Emilia-Romagna', province: 'Parma', name: 'Centro Torri' },
  { code: 'PETA2', region: 'Emilia-Romagna', province: 'Reggio Emilia', name: 'C.C. I Petali' },
  { code: 'MURA', region: 'Emilia-Romagna', province: 'Reggio Emilia', name: 'C.C. Le Mura' },
  // FRIULI VENEZIA GIULIA
  { code: 'TIARE', region: 'Friuli Venezia Giulia', province: 'Gorizia', name: 'Tiare Shopping Center' },
  { code: 'PALMA', region: 'Friuli Venezia Giulia', province: 'Udine', name: 'Palmanova Outlet Village' },
  { code: 'TERMI', region: 'Friuli Venezia Giulia', province: 'Udine', name: 'Parco Commerciale Terminal Nord' },
  // LAZIO
  { code: 'CASS1', region: 'Lazio', province: 'Frosinone', name: 'C.C. Panorama' },
  { code: 'ITA2', region: 'Lazio', province: 'Latina', name: 'C.C. Itaca' },
  { code: 'TIBUR', region: 'Lazio', province: 'Roma', name: 'Roma Tiburtina' },
  { code: 'ANAG2', region: 'Lazio', province: 'Roma', name: 'C.C. Anagnina' },
  { code: 'EUR', region: 'Lazio', province: 'Roma', name: 'C.C. Euroma 2' },
  { code: 'NOCE1', region: 'Lazio', province: 'Roma', name: 'C.C. La Noce' },
  { code: 'RM', region: 'Lazio', province: 'Roma', name: 'C.C. La Romanina' },
  { code: 'PARCO', region: 'Lazio', province: 'Roma', name: 'C.C. Leonardo' },
  { code: 'PRIM2', region: 'Lazio', province: 'Roma', name: 'C.C. Primavera' },
  { code: 'GUID2', region: 'Lazio', province: 'Roma', name: 'C.C. Tiburtino' },
  { code: 'RMEST', region: 'Lazio', province: 'Roma', name: 'C.C. Romaest' },
  { code: 'PORTA', region: 'Lazio', province: 'Roma', name: 'Galleria commerciale Porta di Roma' },
  { code: 'VALMN', region: 'Lazio', province: 'Roma', name: 'Valmontone Outlet Village' },
  { code: 'GRAN', region: 'Lazio', province: 'Roma', name: 'C.C. GranRoma' },
  { code: 'TUSCI', region: 'Lazio', province: 'Viterbo', name: 'C.C. Tuscia' },
  // LIGURIA
  { code: 'GENOA', region: 'Liguria', province: 'Genova', name: 'C.C. Fiumara' },
  { code: 'REMO', region: 'Liguria', province: 'Imperia', name: 'Sanremo C.S.' },
  { code: 'TER02', region: 'Liguria', province: 'La Spezia', name: 'C.C. Le Terrazze' },
  { code: 'GABBI', region: 'Liguria', province: 'Savona', name: 'C.C. Il Gabbiano' },
  // LOMBARDIA
  { code: 'STEZZ', region: 'Lombardia', province: 'Bergamo', name: 'C.C. Le Due Torri' },
  { code: 'FCORT', region: 'Lombardia', province: 'Brescia', name: 'Franciacorta Outlet Village' },
  { code: 'PFRAN', region: 'Lombardia', province: 'Brescia', name: 'C.C. Le Porte Franche' },
  { code: 'CANTU', region: 'Lombardia', province: 'Como', name: 'Gallerie Bennet Cantù' },
  { code: 'BENNE', region: 'Lombardia', province: 'Como', name: 'Gallerie Bennet Como' },
  { code: 'LECC1', region: 'Lombardia', province: 'Lecco', name: 'Gallerie Bennet Lecco' },
  { code: 'MANTO', region: 'Lombardia', province: 'Mantova', name: 'Mantova Outlet Village' },
  { code: 'LECUP', region: 'Lombardia', province: 'Milano', name: 'C.C. Le Cupole' },
  { code: 'METRO', region: 'Lombardia', province: 'Milano', name: 'C.C. Metropoli' },
  { code: 'VIMOD', region: 'Lombardia', province: 'Milano', name: 'C.C. Vimodrone' },
  { code: 'BORRO', region: 'Lombardia', province: 'Milano', name: 'Galleria Borromea Shopping Center' },
  { code: 'VANZ2', region: 'Lombardia', province: 'Milano', name: 'Il Parco Shopping Center' },
  { code: 'BONOL', region: 'Lombardia', province: 'Milano', name: 'C.C. Bonola' },
  { code: 'REDO', region: 'Lombardia', province: 'Milano', name: 'Gallerie Bennet Milano (Redo)' },
  { code: 'SEDR1', region: 'Lombardia', province: 'Milano', name: 'Gallerie Bennet Milano (Sedriano)' },
  { code: 'BRUGH', region: 'Lombardia', province: 'Monza e Brianza', name: 'C.C. Bennet Brugherio' },
  { code: 'GLOBO', region: 'Lombardia', province: 'Monza e Brianza', name: 'C.C. Globo' },
  { code: 'MONZ1', region: 'Lombardia', province: 'Monza e Brianza', name: 'C.C. Rondò dei Pini' },
  { code: 'PAVIA', region: 'Lombardia', province: 'Pavia', name: 'C.C. Carrefour Pavia' },
  { code: 'PV', region: 'Lombardia', province: 'Pavia', name: 'Pavia C.S.' },
  { code: 'DUCAL', region: 'Lombardia', province: 'Pavia', name: 'C.C. Il Ducale' },
  // MARCHE
  { code: 'BENED', region: 'Marche', province: 'Ascoli Piceno', name: 'San Benedetto del Tronto C.S.' },
  { code: 'CHIE1', region: 'Marche', province: 'Macerata', name: 'C.C. Val di Chienti' },
  { code: 'PESAR', region: 'Marche', province: 'Pesaro Urbino', name: 'C.C. Rossini Center' },
  // MOLISE
  { code: 'MOLIS', region: 'Molise', province: 'Campobasso', name: 'C.C. Centro del Molise' },
  { code: 'COSTA', region: 'Molise', province: 'Campobasso', name: 'C.C. Costaverde' },
  { code: 'ISERN', region: 'Molise', province: 'Isernia', name: 'C.C. In Piazza' },
  // PIEMONTE
  { code: 'CITTA', region: 'Piemonte', province: 'Alessandria', name: 'C.C. La Cittadella' },
  { code: 'LIGUR', region: 'Piemonte', province: 'Alessandria', name: 'C.C. Novi Center' },
  { code: 'MOND1', region: 'Piemonte', province: 'Cuneo', name: 'Mondovicino Outlet Village' },
  { code: 'SMART', region: 'Piemonte', province: 'Novara', name: 'C.C. San Martino 2' },
  { code: 'NOVAR', region: 'Piemonte', province: 'Novara', name: 'Vicolungo The Style Outlets' },
  { code: 'TORIN', region: 'Piemonte', province: 'Torino', name: 'Area 12 Shopping Center' },
  { code: 'CHIVA', region: 'Piemonte', province: 'Torino', name: 'C.C. Chivasso' },
  { code: 'NICHE', region: 'Piemonte', province: 'Torino', name: 'C.C. I Viali' },
  { code: 'BEINA', region: 'Piemonte', province: 'Torino', name: 'C.C. Le Fornaci' },
  { code: 'LING8', region: 'Piemonte', province: 'Torino', name: 'C.C. Lingotto' },
  { code: 'PAVO1', region: 'Piemonte', province: 'Torino', name: 'C.C. Pavone' },
  // PUGLIA
  { code: 'MF01', region: 'Puglia', province: 'Bari', name: 'Gran Shopping Mongolfiera' },
  { code: 'MESA1', region: 'Puglia', province: 'Brindisi', name: 'C.C. Appia Antica' },
  { code: 'BRIN3', region: 'Puglia', province: 'Brindisi', name: 'C.C. Le Colonne' },
  { code: 'GARGA', region: 'Puglia', province: 'Foggia', name: 'C.C. Gargano' },
  { code: 'FG', region: 'Puglia', province: 'Foggia', name: 'C.C. Mongolfiera Foggia' },
  { code: 'SURB1', region: 'Puglia', province: 'Lecce', name: 'C.C. Mongolfiera Lecce' },
  { code: 'TARA1', region: 'Puglia', province: 'Taranto', name: 'C.C. Mongolfiera Taranto' },
  // SARDEGNA
  { code: 'GILLA', region: 'Sardegna', province: 'Cagliari', name: 'C.C. I Fenicotteri' },
  { code: 'SESTU', region: 'Sardegna', province: 'Cagliari', name: 'C.C. La Corte del Sole' },
  { code: 'NUORO', region: 'Sardegna', province: 'Nuoro', name: 'C.C. Pratosardo' },
  { code: 'OLBIA', region: 'Sardegna', province: 'Olbia-Tempio', name: 'C.C. Terranova' },
  { code: 'ORIST', region: 'Sardegna', province: 'Oristano', name: 'C.C. Porta Nuova' },
  { code: 'TANIT', region: 'Sardegna', province: 'Sassari', name: 'Galleria Tanit' },
  { code: 'SS', region: 'Sardegna', province: 'Sassari', name: 'Sassari C.S.' },
  // SICILIA
  { code: 'SCIAC', region: 'Sicilia', province: 'Agrigento', name: 'Sciacca C.S.' },
  { code: 'LICAT', region: 'Sicilia', province: 'Agrigento', name: 'C.C. Il Porto' },
  { code: 'TEMP2', region: 'Sicilia', province: 'Agrigento', name: 'C.C. Città dei Templi' },
  { code: 'SANCA', region: 'Sicilia', province: 'Caltanissetta', name: 'C.C. Il Casale' },
  { code: 'GELA', region: 'Sicilia', province: 'Caltanissetta', name: 'Gela C.S.' },
  { code: 'VETNE', region: 'Sicilia', province: 'Catania', name: 'Catania C.S.' },
  { code: 'GIARE', region: 'Sicilia', province: 'Catania', name: 'Riposto C.S.' },
  { code: 'ACESE', region: 'Sicilia', province: 'Catania', name: 'C.C. Il Ciclope' },
  { code: 'GINES', region: 'Sicilia', province: 'Catania', name: 'C.C. Le Ginestre Catania' },
  { code: 'ZAGAR', region: 'Sicilia', province: 'Catania', name: 'C.C. Le Zagare' },
  { code: 'BIKOK', region: 'Sicilia', province: 'Catania', name: 'C.C. Porte di Catania' },
  { code: 'SICIL', region: 'Sicilia', province: 'Catania', name: 'Centro Sicilia' },
  { code: 'BARCE', region: 'Sicilia', province: 'Messina', name: 'Barcellona Pozzo di Gotto C.S.' },
  { code: 'BROLO', region: 'Sicilia', province: 'Messina', name: 'C.C. La Filanda' },
  { code: 'CALAT', region: 'Sicilia', province: 'Palermo', name: 'Palermo C.S.' },
  { code: 'FOR3', region: 'Sicilia', province: 'Palermo', name: 'C.C. Forum' },
  { code: 'KARIN', region: 'Sicilia', province: 'Palermo', name: 'C.C. Poseidon' },
  { code: 'DELTA', region: 'Sicilia', province: 'Ragusa', name: 'C.C. Ibleo' },
  { code: 'MELIL', region: 'Sicilia', province: 'Siracusa', name: 'Parco Commerciale Belvedere' },
  { code: 'MAZAR', region: 'Sicilia', province: 'Trapani', name: 'Mazara del Vallo C.S.' },
  { code: 'TRAPA', region: 'Sicilia', province: 'Trapani', name: 'Trapani C.S.' },
  { code: 'BELIC', region: 'Sicilia', province: 'Trapani', name: 'C.C. Belicittà' },
  // TOSCANA
  { code: 'VALDI', region: 'Toscana', province: 'Arezzo', name: 'Valdichiana Outlet Village' },
  { code: 'FIREN', region: 'Toscana', province: 'Firenze', name: 'Firenze C.S.' },
  { code: 'PONTA', region: 'Toscana', province: 'Firenze', name: 'C.C. Valdisieve' },
  { code: 'SESTO', region: 'Toscana', province: 'Firenze', name: 'Centro Sesto' },
  { code: 'GR', region: 'Toscana', province: 'Grosseto', name: 'C.C. Aurelia Antica' },
  { code: 'CECIN', region: 'Toscana', province: 'Livorno', name: 'C.C. Corte Acquerta' },
  { code: 'ELBA', region: 'Toscana', province: 'Livorno', name: 'C.C. Eurospin Elba' },
  { code: 'FONTI', region: 'Toscana', province: 'Livorno', name: 'C.C. Fonti del Corallo' },
  { code: 'MASS2', region: 'Toscana', province: 'Massa-Carrara', name: 'C.C. MareMonti' },
  { code: 'DERA', region: 'Toscana', province: 'Pisa', name: 'Pontedera' },
  { code: 'PISTO', region: 'Toscana', province: 'Pistoia', name: 'C.C. Panorama Pistoia' },
  // TRENTINO-ALTO ADIGE
  { code: 'BOLZA', region: 'Trentino-Alto Adige', province: 'Bolzano', name: 'Galleria Twenty' },
  // UMBRIA
  { code: 'PG', region: 'Umbria', province: 'Perugia', name: 'C.C. Emisfero' },
  // VENETO
  { code: 'PADOV', region: 'Veneto', province: 'Padova', name: 'Padova C.S.' },
  { code: 'ADIGE', region: 'Veneto', province: 'Verona', name: 'C.C. Adigeo' },
  { code: 'LEGNA', region: 'Veneto', province: 'Verona', name: 'C.C. Galassia' },
  { code: 'MELA', region: 'Veneto', province: 'Verona', name: 'C.C. La Grande Mela' },
  { code: 'BUSS1', region: 'Veneto', province: 'Verona', name: "C.C. Porte dell'Adige" },
  { code: 'VERON', region: 'Veneto', province: 'Verona', name: 'C.C. Verona Uno' },
  { code: 'VICEN', region: 'Veneto', province: 'Vicenza', name: 'C.C. Vicenza' },
];

const BY_CODE: Record<string, SiacloudStore> = Object.fromEntries(
  SIACLOUD_STORES.map((s) => [s.code, s])
);

export function getSiacloudStore(code: string): SiacloudStore | undefined {
  return BY_CODE[code.toUpperCase()];
}

export function describeSiacloudStore(code: string): string {
  const s = BY_CODE[code.toUpperCase()];
  return s ? `${s.name} (${s.province}, ${s.region})` : code;
}
