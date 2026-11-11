'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { createProductTemplate, type ProductInput, type ProductSummary } from '@/shared/products';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';

type Props = {
  mode: 'create' | 'edit';
  productId?: string;
  initial?: ProductInput;
};

export function ProductForm({ mode, productId, initial }: Props) {
  const router = useRouter();
  const [data, setData] = useState<ProductInput>(initial ?? createProductTemplate());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function fillTemplate() {
    setData((prev) => createProductTemplate(prev.name || 'Nouveau Produit', prev.slug || 'nouveau-produit', prev.price || 3300));
  }

  function updateField<K extends keyof ProductInput>(key: K, value: ProductInput[K]) {
    setData((prev) => ({ ...prev, [key]: value }));
  }

  // Shades management
  function addShade() {
    const nextNum = String(data.shades.length + 1).padStart(2, '0');
    setData((prev) => ({
      ...prev,
      shades: [...prev.shades, { code: `*${nextNum}`, color: '#ff69b4', image: `/assets/shade-${nextNum}.png` }],
    }));
  }

  function removeShade(index: number) {
    if (data.shades.length <= 1) return;
    setData((prev) => ({ ...prev, shades: prev.shades.filter((_, i) => i !== index) }));
  }

  function updateShade(index: number, field: 'code' | 'color' | 'image', val: string) {
    setData((prev) => ({
      ...prev,
      shades: prev.shades.map((s, i) => (i === index ? { ...s, [field]: val } : s)),
    }));
  }

  // Gallery slides management
  function addSlide() {
    setData((prev) => ({
      ...prev,
      slides: [...prev.slides, { src: '/assets/wet-kiss.jpg', alt: prev.name, thumbLabel: 'Photo', uncropped: false }],
    }));
  }

  function removeSlide(index: number) {
    setData((prev) => ({ ...prev, slides: prev.slides.filter((_, i) => i !== index) }));
  }

  function updateSlide(index: number, field: 'src' | 'alt', val: string) {
    setData((prev) => ({
      ...prev,
      slides: prev.slides.map((s, i) => (i === index ? { ...s, [field]: val } : s)),
    }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setSaved(false);

    if (!data.name.trim()) {
      setError('Le nom du produit est requis.');
      return;
    }
    if (!data.slug.trim()) {
      setError('L’identifiant URL (slug) est requis.');
      return;
    }
    if (data.shades.length === 0) {
      setError('Au moins une teinte est requise.');
      return;
    }

    setBusy(true);
    const result =
      mode === 'create'
        ? await api<ProductSummary>('/api/products', { method: 'POST', body: data })
        : await api<ProductSummary>(`/api/products/${productId}`, { method: 'PATCH', body: data });
    setBusy(false);

    if (!result.ok) {
      setError(apiMessage(result.code));
      return;
    }

    if (mode === 'create') {
      router.push(`/admin/produits?created=1`);
      router.refresh();
      return;
    }

    setSaved(true);
    router.refresh();
  }

  return (
    <form className="p-form" method="post" onSubmit={onSubmit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="success">Produit enregistré avec succès.</Notice> : null}

      {mode === 'create' ? (
        <div style={{ marginBottom: '1rem' }}>
          <button type="button" className="dl-btn dl-btn--ghost" onClick={fillTemplate}>
            ✨ Remplir avec le modèle de présentation complet
          </button>
        </div>
      ) : null}

      <div className="p-grid p-grid--2">
        <Field label="Nom du produit" hint="Ex: Wet Kiss, Velvet Gloss, Lip Oil">
          <input
            type="text"
            required
            value={data.name}
            onChange={(e) => updateField('name', e.target.value)}
            placeholder="Nom du produit"
          />
        </Field>

        <Field label="Identifiant URL (slug)" hint="Ex: wet-kiss, velvet-touch. Accessible sur /produit/[slug]">
          <input
            type="text"
            required
            value={data.slug}
            onChange={(e) => updateField('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            placeholder="slug-du-produit"
          />
        </Field>

        <Field label="Prix unitaire (en DA)" hint="Prix de vente en dinars algériens">
          <input
            type="number"
            min={0}
            step={50}
            required
            value={data.price}
            onChange={(e) => updateField('price', parseInt(e.target.value, 10) || 0)}
          />
        </Field>

        <Field label="Stock disponible" hint="Quantité disponible en inventaire">
          <input
            type="number"
            min={0}
            required
            value={data.stock}
            onChange={(e) => updateField('stock', parseInt(e.target.value, 10) || 0)}
          />
        </Field>
      </div>

      <div className="p-grid p-grid--2">
        <Field label="Quantité max par commande">
          <input
            type="number"
            min={1}
            max={50}
            value={data.maxQuantity}
            onChange={(e) => updateField('maxQuantity', parseInt(e.target.value, 10) || 20)}
          />
        </Field>

        <Field label="Surtitre (Eyebrow)" hint="Ex: LIP FONDUE · MADE IN KOREA">
          <input
            type="text"
            value={data.eyebrow}
            onChange={(e) => updateField('eyebrow', e.target.value)}
          />
        </Field>
      </div>

      <Field label="Description principale">
        <textarea
          rows={3}
          value={data.description}
          onChange={(e) => updateField('description', e.target.value)}
          placeholder="Présentation accrocheuse du produit"
        />
      </Field>

      <Field label="Texte défilant (Marquee)" hint="Bandeau animé sous la fiche d'achat">
        <input
          type="text"
          value={data.marquee}
          onChange={(e) => updateField('marquee', e.target.value)}
          placeholder="WET LIPS. BIG CRUSH."
        />
      </Field>

      <fieldset className="p-fieldset">
        <legend>Teintes & Couleurs ({data.shades.length})</legend>
        <p className="p-subtle">Chaque teinte a un code affiché, une couleur pastille (hex) et une image de rendu.</p>
        <div className="p-stack">
          {data.shades.map((shade, idx) => (
            <div key={idx} className="p-grid p-grid--3 glass" style={{ padding: '0.75rem', borderRadius: '8px', alignItems: 'center' }}>
              <div>
                <label className="dl-field__label">Code (ex: *01)</label>
                <input
                  type="text"
                  value={shade.code}
                  onChange={(e) => updateShade(idx, 'code', e.target.value)}
                />
              </div>
              <div>
                <label className="dl-field__label">Couleur hex</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="color"
                    value={shade.color.startsWith('#') ? shade.color : '#fdecdd'}
                    onChange={(e) => updateShade(idx, 'color', e.target.value)}
                    style={{ width: '40px', height: '36px', padding: 0, border: 'none', cursor: 'pointer' }}
                  />
                  <input
                    type="text"
                    value={shade.color}
                    onChange={(e) => updateShade(idx, 'color', e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="dl-field__label">Image URL / Chemin</label>
                  <input
                    type="text"
                    value={shade.image}
                    onChange={(e) => updateShade(idx, 'image', e.target.value)}
                  />
                </div>
                {data.shades.length > 1 ? (
                  <button type="button" className="dl-btn dl-btn--ghost" onClick={() => removeShade(idx)} title="Supprimer">
                    ✕
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          <button type="button" className="dl-btn dl-btn--ghost" onClick={addShade} style={{ alignSelf: 'flex-start' }}>
            + Ajouter une teinte
          </button>
        </div>
      </fieldset>

      <fieldset className="p-fieldset">
        <legend>Photos & Galerie ({data.slides.length})</legend>
        <div className="p-stack">
          {data.slides.map((slide, idx) => (
            <div key={idx} className="p-grid p-grid--2 glass" style={{ padding: '0.75rem', borderRadius: '8px', alignItems: 'center' }}>
              <div>
                <label className="dl-field__label">URL ou chemin de l’image</label>
                <input
                  type="text"
                  value={slide.src}
                  onChange={(e) => updateSlide(idx, 'src', e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="dl-field__label">Texte alternatif</label>
                  <input
                    type="text"
                    value={slide.alt}
                    onChange={(e) => updateSlide(idx, 'alt', e.target.value)}
                  />
                </div>
                <button type="button" className="dl-btn dl-btn--ghost" onClick={() => removeSlide(idx)} title="Supprimer">
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="dl-btn dl-btn--ghost" onClick={addSlide} style={{ alignSelf: 'flex-start' }}>
            + Ajouter une photo
          </button>
        </div>
      </fieldset>

      <fieldset className="p-fieldset">
        <legend>Vidéos & Médias</legend>
        <div className="p-grid p-grid--2">
          <Field label="Vidéo Effet (Desktop)" hint="Chemin ou URL MP4">
            <input
              type="text"
              value={data.effect.video.desktop}
              onChange={(e) =>
                setData((prev) => ({
                  ...prev,
                  effect: { ...prev.effect, video: { ...prev.effect.video, desktop: e.target.value } },
                }))
              }
            />
          </Field>
          <Field label="Vidéo Effet (Mobile)" hint="Version optimisée mobile">
            <input
              type="text"
              value={data.effect.video.mobile}
              onChange={(e) =>
                setData((prev) => ({
                  ...prev,
                  effect: { ...prev.effect, video: { ...prev.effect.video, mobile: e.target.value } },
                }))
              }
            />
          </Field>
          <Field label="Vidéo Rituel d'application" hint="Chemin ou URL MP4">
            <input
              type="text"
              value={data.ritual.video.desktop}
              onChange={(e) =>
                setData((prev) => ({
                  ...prev,
                  ritual: { ...prev.ritual, video: { ...prev.ritual.video, desktop: e.target.value } },
                }))
              }
            />
          </Field>
          <Field label="Ingrédients">
            <input
              type="text"
              value={data.ingredients}
              onChange={(e) => updateField('ingredients', e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
        <label className="p-check">
          <input
            type="checkbox"
            checked={data.isActive}
            onChange={(e) => updateField('isActive', e.target.checked)}
          />
          <span>Produit actif (visible à la commande)</span>
        </label>
      </div>

      <div className="p-form__actions">
        <Button type="submit" busy={busy}>
          {mode === 'create' ? 'Créer le produit' : 'Enregistrer les modifications'}
        </Button>
      </div>
    </form>
  );
}
