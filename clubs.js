// Centres-écoles de parachutisme (FFP) : coordonnées de l'aérodrome, pour la recherche « Nouvelle zone ».
// Commun à Setup PSV, prepo-PA et vecteur-largage. Liste établie le 19/11/2026 (fiches FFP + aérodromes OurAirports).
const CLUBS = [
  { c: '8201', n: 'Bouloc Skydive – École de parachutisme Midi-Pyrénées', v: 'Bouloc-en-Quercy (82)', k: 'bouloc cardenal epmp quercy', lat: 44.3078, lng: 1.08108 },
  { c: '', n: 'Skydive Occitanie / Chutextrem – Lézignan-Corbières', v: 'Lézignan-Corbières (11)', k: 'lezignan corbieres flyzone occitanie chutextrem conilhac', lat: 43.1743, lng: 2.7404 },
  { c: '4601', n: 'Centre École de Parachutisme de Cahors', v: 'Cahors-Lalbenque (46)', k: 'cahors lalbenque cieurac', lat: 44.351398, lng: 1.47528 },
  { c: '4901', n: 'École Française de Parachutisme de Saumur', v: 'Saumur (49)', k: 'saumur efp terrefort', lat: 47.256802, lng: -0.115142 },
  { c: '6701', n: 'Centre École Régional de Parachutisme Alsace', v: 'Strasbourg-Neuhof, Polygone (67)', k: 'strasbourg alsace polygone neuhof', lat: 48.553263, lng: 7.776604 },
  { c: '4501', n: 'École de Parachutisme du Centre Orléans Loiret (EPCOL)', v: 'Orléans-Saint-Denis-de-l\'Hôtel (45)', k: 'orleans loiret epcol saint denis hotel', lat: 47.897758, lng: 2.164478 },
  { c: '0901', n: 'CEPS de l\'Ariège', v: 'Pamiers-Les Pujols (09)', k: 'pamiers ariege pujols ceps', lat: 43.090599, lng: 1.69583 },
  { c: '0501', n: 'CERPS de Tallard', v: 'Gap-Tallard (05)', k: 'tallard gap cerps', lat: 44.455002, lng: 6.03778 },
  { c: '0510', n: 'France Parachutisme', v: 'Gap-Tallard (05)', k: 'tallard gap', lat: 44.455002, lng: 6.03778 },
  { c: '0519', n: 'Skydive Center', v: 'Gap-Tallard (05)', k: 'tallard gap skydivecenter', lat: 44.455002, lng: 6.03778 },
  { c: '1018', n: 'Aube Parachutisme (Blowind)', v: 'Brienne-le-Château (10)', k: 'brienne aube blowind', lat: 48.430396, lng: 4.472487 },
  { c: '1702', n: 'Royan Océan Parachutisme', v: 'Royan-Médis (17)', k: 'royan medis ocean', lat: 45.628101, lng: -0.9725 },
  { c: '2212', n: 'Septième Ciel', v: 'Lannion (22)', k: 'lannion septieme ciel 7eme', lat: 48.754398, lng: -3.47166 },
  { c: '2502', n: 'École de Parachutisme Besançon Franche-Comté', v: 'Besançon-La Vèze (25)', k: 'besancon veze franche comte', lat: 47.206615, lng: 6.083168 },
  { c: '3001', n: 'Skydive Pujaut – École Française de Parachutisme', v: 'Avignon-Pujaut (30)', k: 'pujaut avignon volomax', lat: 43.996899, lng: 4.75556 },
  { c: '3301', n: 'EPS du Bassin d\'Arcachon', v: 'Arcachon-Villemarie, La Teste-de-Buch (33)', k: 'arcachon villemarie teste buch', lat: 44.596401, lng: -1.11083 },
  { c: '3328', n: 'Espace Chute Libre', v: 'La Réole-Floudes (33)', k: 'reole floudes gironde espace chute libre', lat: 44.5681, lng: -0.056111 },
  { c: '3601', n: 'École Française de Parachutisme Le Blanc', v: 'Le Blanc (36)', k: 'le blanc efp indre', lat: 46.6208, lng: 1.0875 },
  { c: '3801', n: 'Centre École Parachutisme de Grenoble', v: 'Grenoble-Isère, Saint-Étienne-de-Saint-Geoirs (38)', k: 'grenoble isere saint etienne geoirs cepg', lat: 45.3629, lng: 5.32937 },
  { c: '4701', n: 'École de Parachutisme d\'Agen', v: 'Agen-La Garenne (47)', k: 'agen garenne passage', lat: 44.174171, lng: 0.59309 },
  { c: '5301', n: 'Parachutisme Laval Centre École Mayenne', v: 'Laval-Entrammes (53)', k: 'laval mayenne entrammes', lat: 48.032208, lng: -0.743999 },
  { c: '5401', n: 'EFP Nancy Lorraine', v: 'Nancy-Azelot (54)', k: 'nancy lorraine azelot', lat: 48.59347, lng: 6.241035 },
  { c: '5601', n: 'École de Parachutisme Sportif de Vannes Bretagne', v: 'Vannes-Meucon, Monterblanc (56)', k: 'vannes meucon monterblanc bretagne', lat: 47.723301, lng: -2.71856 },
  { c: '5902', n: 'École Française de Parachutisme Lille Bondues', v: 'Lille-Marcq, Bondues (59)', k: 'lille bondues marcq', lat: 50.687199, lng: 3.07556 },
  { c: '5904', n: 'CERP de Maubeuge', v: 'Maubeuge-Élesmes, Vieux-Reng (59)', k: 'maubeuge elesmes salmagne vieux reng', lat: 50.310501, lng: 4.03312 },
  { c: '6201', n: 'Centre École Régional de Parachutisme Lens', v: 'Lens-Bénifontaine (62)', k: 'lens benifontaine', lat: 50.4664, lng: 2.81972 },
  { c: '6901', n: 'École de Parachutisme de Lyon-Corbas', v: 'Lyon-Corbas (69)', k: 'lyon corbas', lat: 45.654202, lng: 4.91361 },
  { c: '7119', n: 'Angel Parachutisme', v: 'Chalon-Champforgeuil (71)', k: 'chalon champforgeuil saone angel', lat: 46.825813, lng: 4.817646 },
  { c: '7324', n: 'Savoie Parachutisme', v: 'Chambéry-Aix-les-Bains (73)', k: 'savoie chambery aix bains viviers', lat: 45.6381, lng: 5.88023 },
  { c: '8019', n: 'Centre de Parachutisme Paris Péronne Haute Somme', v: 'Péronne-Saint-Quentin (80)', k: 'peronne somme saint quentin', lat: 49.868871, lng: 3.029566 },
  { c: '8301', n: 'Centre École de Parachutisme Côte d\'Azur', v: 'Le Luc-Le Cannet (83)', k: 'le luc cannet maures cote azur', lat: 43.384701, lng: 6.38714 },
  { c: '8914', n: 'Paris Jump', v: 'Saint-Florentin-Chéu (89)', k: 'saint florentin cheu paris jump yonne', lat: 47.98019, lng: 3.775583 },
  { c: '9704', n: 'PC de Bourbon / CEP de la Réunion', v: 'Saint-Pierre-Pierrefonds (974)', k: 'reunion bourbon saint pierre pierrefonds', lat: -21.319362, lng: 55.422506 }
];
// Recherche sans accents ni majuscules : chaque mot tapé doit se retrouver dans le nom, le lieu ou les mots-clés
function searchClubs(q) {
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = norm(q).split(' ').filter(w => w.length >= 2 && !['de', 'la', 'le', 'les', 'du', 'des', 'en', 'club', 'ecole', 'parachutisme', 'skydive', 'centre', 'zone'].includes(w));
  if (!words.length) return [];
  return CLUBS.filter(c => { const t = norm(c.n + ' ' + c.v + ' ' + c.k + ' ' + c.c); return words.every(w => t.includes(w)); }).slice(0, 8);
}
