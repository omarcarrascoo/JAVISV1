import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

// 🛠️ El menú de comandos que aparecerá en tu Discord
const commands = [
    new SlashCommandBuilder()
        .setName('workon')
        .setDescription('Cambia el repositorio activo en el que Jarvis está trabajando.')
        .addStringOption(option => 
            option.setName('repo')
                .setDescription('Nombre de la carpeta del repositorio (ej. mi-app-expo)')
                .setRequired(true)),
                
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Muestra en qué proyecto está trabajando Jarvis actualmente.'),
        
    new SlashCommandBuilder()
        .setName('init')
        .setDescription('Crea la estructura base para un nuevo proyecto.')
        .addStringOption(option => 
            option.setName('type')
                .setDescription('El tipo de arquitectura')
                .setRequired(true)
                .addChoices(
                    { name: 'Expo (Frontend Mobile)', value: 'expo' },
                    { name: 'NestJS (Backend API)', value: 'nest' }
                ))
        .addStringOption(option => 
            option.setName('name')
                .setDescription('El nombre de tu nuevo proyecto (sin espacios)')
                .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN as string);

(async () => {
    try {
        console.log('🚀 Registrando Slash Commands en Discord...');
        
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID as string),
            { body: commands },
        );
        
        console.log('✅ ¡Comandos registrados con éxito!');
        console.log('👉 Ve a tu servidor de Discord y escribe "/" para verlos.');
    } catch (error) {
        console.error('❌ Error registrando comandos:', error);
    }
})();