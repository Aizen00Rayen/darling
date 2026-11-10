'use strict';
const cfg=window.DARLING_CONFIG;
const $=s=>document.querySelector(s);
const money=n=>n.toLocaleString('fr-FR')+' DA';
let selected=0,quantity=1,photoIndex=0;
const photos=[['assets/wet-kiss.jpg','Wet Kiss : fini brillant sur les lèvres'],['assets/model.jpg','Wet Kiss : photo originale du produit'],['assets/texture.jpg','Wet Kiss rose en main']];
photos.push(['assets/shade-comparison.png','Comparatif Wet Kiss : teintes 01, 02, 03 et 04']);
for(let shade=1;shade<=4;shade++)photos.push([`assets/shade-0${shade}.png`,`Wet Kiss : rendu réel de la teinte 0${shade}`]);
const thumbContainer=$('.thumbs');
photos.slice(3).forEach(([src,alt],offset)=>{const button=document.createElement('button');button.type='button';button.className='thumb';button.dataset.photo=offset+3;button.setAttribute('aria-label',alt);button.setAttribute('aria-pressed','false');const image=document.createElement('img');image.src=src;image.alt='';image.width=80;image.height=80;image.loading='lazy';button.append(image);thumbContainer.insertBefore(button,thumbContainer.querySelector(':scope > span'))});
const form=$('#commande'),wilaya=$('#wilaya'),submit=$('#submit');
cfg.wilayas.forEach((name,i)=>{const option=document.createElement('option');option.value=name;option.textContent=String(i+1).padStart(2,'0')+' — '+name;wilaya.append(option)});
$('#access-key').value=cfg.accessKey;$('#ingredients').textContent=cfg.ingredients;$('#year').textContent=new Date().getFullYear();
function update(){
  const region=wilaya.selectedIndex-1,home=$('input[name="Mode de livraison"]:checked').value==='Domicile';
  const desk=$('input[value="Stop Desk"]');
  // A zero in the source delivery table means no desk service, never free shipping.
  desk.disabled=region>=0&&cfg.bureau[region]===0;
  if(desk.disabled&&desk.checked){$('input[value="Domicile"]').checked=true;return update()}
  $('#address-wrap').hidden=!home;$('#address').disabled=!home;$('#address').required=home;
  const shipping=region<0?null:(home?cfg.domicile[region]:cfg.bureau[region]);
  const total=cfg.price*quantity+(shipping||0);
  $('#quantity').value=quantity;$('#minus').disabled=quantity<=1;$('#plus').disabled=quantity>=20;
  $('#shipping-price').textContent=shipping===null?'Choisissez une wilaya':money(shipping);
  $('#total-price').textContent=money(total);$('#shade-name').textContent=cfg.shades[selected].code;$('#mobile-shade').textContent=cfg.shades[selected].code;
  $('#order-shade').value=cfg.shades[selected].code;$('#order-quantity').value=quantity;$('#order-shipping').value=shipping===null?'':money(shipping);$('#order-total').value=money(total);
  document.querySelectorAll('.swatch').forEach((el,i)=>{el.classList.toggle('active',i===selected);el.setAttribute('aria-pressed',String(i===selected))});
}
document.querySelectorAll('.swatch').forEach(el=>el.addEventListener('click',()=>{
  selected=Number(el.dataset.shade);update();
  showPhoto(selected+4);
  if(matchMedia('(max-width: 700px)').matches)$('.gallery').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
}));
function showPhoto(index){photoIndex=(index+photos.length)%photos.length;$('#hero').src=photos[photoIndex][0];$('#hero').alt=photos[photoIndex][1];$('.hero-photo').classList.toggle('shade-photo',photoIndex>=3);$('#photo-counter').textContent=String(photoIndex+1).padStart(2,'0')+' / '+String(photos.length).padStart(2,'0');document.querySelectorAll('.thumb').forEach((el,i)=>{el.classList.toggle('active',i===photoIndex);el.setAttribute('aria-pressed',String(i===photoIndex))})}
document.querySelectorAll('.thumb').forEach(el=>el.addEventListener('click',()=>showPhoto(Number(el.dataset.photo))));$('#prev').onclick=()=>showPhoto(photoIndex-1);$('#next').onclick=()=>showPhoto(photoIndex+1);
$('#minus').onclick=()=>{quantity=Math.max(1,quantity-1);update()};$('#plus').onclick=()=>{quantity=Math.min(20,quantity+1);update()};
wilaya.addEventListener('change',update);document.querySelectorAll('input[name="Mode de livraison"]').forEach(el=>el.addEventListener('change',update));
form.addEventListener('submit',async event=>{
  event.preventDefault();if(submit.disabled)return;update();
  const phone=form.elements['Téléphone'],normalPhone=phone.value.replace(/\s/g,'');
  if(!/^(?:0[567]\d{8}|\+213[567]\d{8})$/.test(normalPhone)){phone.setCustomValidity('Saisissez un numéro algérien valide (10 chiffres ou +213).');phone.reportValidity();return}phone.setCustomValidity('');
  if(!form.reportValidity())return;
  const status=$('#status');status.hidden=false;status.textContent='Envoi de votre commande…';submit.disabled=true;form.setAttribute('aria-busy','true');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
  try{const response=await fetch(form.action,{method:'POST',body:new FormData(form),signal:controller.signal,headers:{Accept:'application/json'}});const data=await response.json();if(!response.ok||!data.success)throw new Error('Submission failed');window.location.assign('merci.html')}
  catch(error){status.textContent=error.name==='AbortError'?'La confirmation prend trop de temps. Vérifiez votre connexion avant de réessayer ; votre demande a peut-être été reçue.':'La commande n’a pas pu être confirmée. Vos informations sont conservées dans le formulaire ; veuillez réessayer.';submit.disabled=false}
  finally{clearTimeout(timeout);form.removeAttribute('aria-busy')}
});
form.elements['Téléphone'].addEventListener('input',event=>event.target.setCustomValidity(''));
const videoObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{
  const video=entry.target;
  if(entry.isIntersecting&&entry.intersectionRatio>=.2){
    if(!video.getAttribute('src')){
      video.src=matchMedia('(max-width: 700px)').matches?video.dataset.mobile:video.dataset.desktop;
      video.load();
    }
    video.muted=true;
    video.play().catch(()=>{});
  }else video.pause();
}),{threshold:[0,.2]});
document.querySelectorAll('.product-video').forEach(video=>videoObserver.observe(video));
new IntersectionObserver(entries=>{$('.mobile-buy').classList.toggle('in-form',entries[0].isIntersecting)},{threshold:.05}).observe(form);
update();
